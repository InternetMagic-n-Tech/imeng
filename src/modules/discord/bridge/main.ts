import http from "node:http";
import { decide, pictures, MAX_PICTURE_BYTES } from "./route.js";
import { buildTranscript } from "./transcript.js";
import { DiscordReply } from "./stream.js";
import { askProxy } from "./proxy.js";
import { extractPictures } from "./pictures.js";
import { DmFilter } from "./direct.js";
import { Joins } from "./joins.js";
import type { BotClient, ChatPart, DMessage } from "./types.js";
import type { ResolvedBot, ResolvedConfig } from "./config.js";

/**
 * The bridge: for every configured bot, listen for messages, decide whether one is for the bot, rebuild that conversation from the channel, ask the
 * proxy (an ordinary OpenAI-compatible request) and write the streamed answer back by editing a message in place. The proxy never sees a bot token,
 * and the engine does not know it is Discord: identity travels in the same headers Open WebUI uses, with the Discord user id.
 */

export const DM_FAILED = "I could not send you a direct message. Allow direct messages from server members, then try again.";
export const FRIENDLY_ERROR = "Sorry, I couldn't reach the game right now. Please try again in a moment.";

export interface BridgeDeps {
  makeClient(bot: ResolvedBot): BotClient;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
  /** Milliseconds between "typing..." signals (Discord shows one for about ten seconds). */
  typingEveryMs?: number;
  minEditMs?: number;
  /** Where the join points are kept (default ./saves/discord-joins.json; null keeps them in memory only). */
  joinsFile?: string | null;
  /** How often private notices are pushed as direct messages (default 15 s; 0 turns it off). */
  pollMs?: number;
  /** How often hidden people are given their channel back when their ban has ended (default a minute). */
  kickCheckMs?: number;
}

export interface Bridge { stop(): Promise<void>; address(): { host: string; port: number } | null; ready(): string[] }

/** Messages of one conversation are answered one at a time, in the order they came. */
class Queues {
  private tails = new Map<string, Promise<void>>();
  run(key: string, job: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

export async function runBridge(config: ResolvedConfig, deps: BridgeDeps): Promise<Bridge> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const queues = new Queues();
  const clients: { bot: ResolvedBot; client: BotClient }[] = [];
  const ready = new Set<string>();
  const timers: ReturnType<typeof setInterval>[] = []; // the background loops, stopped with the bridge
  const joins = new Joins(deps.joinsFile === undefined ? (process.env.DISCORD_JOINS_FILE || "./saves/discord-joins.json") : deps.joinsFile);

  const answer = async (bot: ResolvedBot, client: BotClient, m: DMessage, chatKey: string, text: string): Promise<void> => {
    const t0 = Date.now();
    const typing = setInterval(() => { client.api.typing(m.channelId).catch(() => {}); }, deps.typingEveryMs ?? 8000);
    typing.unref();
    client.api.typing(m.channelId).catch(() => {});
    const reply = new DiscordReply(client.api, m.channelId, m.id, { minEditMs: deps.minEditMs });
    const direct = new DmFilter();
    try {
      const since = joins.joinedAt(m.channelId, m.createdAt); // nothing from before the bot joined is ever read, even when Discord would hand it over
      const history = (await client.api.fetchHistory(m.channelId, bot.options.historyLimit)).filter((h) => h.createdAt >= since || h.id === m.id);
      const t = buildTranscript({ history, pending: m, pendingText: text, selfId: client.selfId, scope: bot.options.scope, mergeContext: bot.options.mergeContext });
      const pics = pictures(m); // what the person attached to this message: fetched here, handed on as data: images (the engine keeps them as files)
      const parts: ChatPart[] = [];
      for (const p of pics) {
        try {
          const r = await (deps.fetchFn ?? fetch)(p.url);
          if (!r.ok) throw new Error(`Discord answered ${r.status}`);
          const bytes = Buffer.from(await r.arrayBuffer());
          if (bytes.length <= MAX_PICTURE_BYTES) parts.push({ type: "image_url", image_url: { url: `data:${p.contentType};base64,${bytes.toString("base64")}` } });
        } catch (e) { log(`[bridge ${bot.name}] ${chatKey}: could not fetch an attached picture: ${(e as Error).message}`); }
      }
      if (parts.length) { const last = t.messages[t.messages.length - 1]!; last.content = [{ type: "text", text: String(last.content) }, ...parts]; }
      const settings = Object.keys(bot.context).length ? `Bot settings: ${JSON.stringify(bot.context)}` : "";
      const context = [settings, t.context].filter(Boolean).join("\n");
      await askProxy({
        baseUrl: bot.proxy.url, apiKey: bot.proxy.apiKey, model: bot.options.modelId || bot.model || "text-game",
        messages: t.messages, chatId: chatKey, user: { id: m.authorId, name: m.authorName }, context, fetchFn: deps.fetchFn,
        onDelta: (d) => reply.push(direct.push(d)),
        onKick: (uid, until) => { // a person banned at this table is hidden from this channel until the ban ends
          client.api.kick(m.channelId, uid).then(() => { joins.kick(m.channelId, uid, until); log(`[bridge ${bot.name}] ${chatKey}: removed a player from the channel until ${new Date(until).toISOString()}`); })
            .catch((e) => log(`[bridge ${bot.name}] ${chatKey}: could not remove a player from the channel: ${(e as Error).message}`));
        },
      });
      await reply.push(direct.end());
      await reply.finish();
      for (const text of direct.captured) { // text for this person only (a link code): never in the channel
        try { await client.api.dm(m.authorId, text); }
        catch (e) { log(`[bridge ${bot.name}] ${chatKey}: could not send a direct message: ${(e as Error).message}`); await client.api.send(m.channelId, DM_FAILED, m.id).catch(() => {}); }
      }
      const found = extractPictures(reply.full);
      if (found.files.length) await reply.rewrite(found.text);
      for (const file of found.files) { // a picture made by the game: fetched from the proxy and attached
        try {
          const r = await (deps.fetchFn ?? fetch)(`${new URL(bot.proxy.url).origin}/images/${file}`);
          if (!r.ok) throw new Error(`the proxy answered ${r.status}`);
          await client.api.sendImage(m.channelId, new Uint8Array(await r.arrayBuffer()), file, m.id);
        } catch (e) { log(`[bridge ${bot.name}] ${chatKey}: could not attach picture ${file}: ${(e as Error).message}`); }
      }
      log(`[bridge ${bot.name}] ${chatKey}: answered in ${Date.now() - t0} ms (${reply.full.length} chars, ${reply.messages} message(s), ${reply.edits} edit(s))`);
    } catch (e) {
      log(`[bridge ${bot.name}] ${chatKey}: failed after ${Date.now() - t0} ms: ${(e as Error).message}`);
      try { if (reply.started) await reply.finish(); else await client.api.send(m.channelId, FRIENDLY_ERROR, m.id); }
      catch (e2) { log(`[bridge ${bot.name}] could not tell the channel about the failure: ${(e2 as Error).message}`); }
    } finally { clearInterval(typing); }
  };

  for (const bot of config.bots) {
    for (const w of bot.warnings) log(`[bridge] warning: ${w}`);
    const client = deps.makeClient(bot);
    client.onMessage((m) => {
      const d = decide(bot, bot.options.scope, m, client.selfId);
      if (!joins.mayAnswer(m.channelId, d.answer) || !d.answer) return;
      void queues.run(d.chatKey, () => answer(bot, client, m, d.chatKey, d.text));
    });
    const pushNotices = async (): Promise<void> => { // private notices (a re-entry code, a peek the dealer must hear of) go to the person as a direct message
      try {
        const base = new URL(bot.proxy.url).origin, headers: Record<string, string> = { "content-type": "application/json", ...(bot.proxy.apiKey ? { authorization: `Bearer ${bot.proxy.apiKey}` } : {}) };
        const r = await (deps.fetchFn ?? fetch)(`${base}/admin/announcements?prefix=${encodeURIComponent("discord:")}`, { headers });
        if (!r.ok) return;
        const items = ((await r.json()) as { items?: { key: string; id: string; to: string; text: string }[] }).items ?? [];
        const done: { key: string; id: string }[] = [];
        for (const it of items) {
          if (!it.key.includes(`discord:${bot.name}:`)) continue; // only this bot's own chats
          try { await client.api.dm(it.to.replace(/^discord:/, ""), it.text); done.push({ key: it.key, id: it.id }); }
          catch (e) { log(`[bridge ${bot.name}] could not send a notice by direct message (it will be told in the chat instead): ${(e as Error).message}`); }
        }
        if (done.length) await (deps.fetchFn ?? fetch)(`${base}/admin/announcements/ack`, { method: "POST", headers, body: JSON.stringify({ items: done }) });
      } catch { /* the proxy is unreachable for now: tried again next time */ }
    };
    if (deps.pollMs !== 0) { timers.push(setInterval(() => void pushNotices(), deps.pollMs ?? 15_000)); timers.at(-1)!.unref(); }
    const giveBack = (): void => { for (const k of joins.due()) client.api.unkick(k.channelId, k.userId).catch((e) => log(`[bridge ${bot.name}] could not give a channel back: ${(e as Error).message}`)); };
    giveBack(); timers.push(setInterval(giveBack, deps.kickCheckMs ?? 60_000)); timers.at(-1)!.unref(); // a ban that has ended lets the person see the channel again
    client.onJoin?.((e) => { for (const c of e.channelIds) joins.joined(c); });
    client.onLeave?.((e) => { // removed from a place where several people talk: everything kept for it is dropped, here and in the proxy
      const prefixes = e.channelIds.map((c) => `discord:${bot.name}:${c}`);
      for (const c of e.channelIds) joins.left(c);
      void (async () => {
        try {
          const r = await (deps.fetchFn ?? fetch)(`${new URL(bot.proxy.url).origin}/admin/evict`, { method: "POST", headers: { "content-type": "application/json", ...(bot.proxy.apiKey ? { authorization: `Bearer ${bot.proxy.apiKey}` } : {}) }, body: JSON.stringify({ prefixes }) });
          log(`[bridge ${bot.name}] left ${prefixes.length} channel(s): the proxy answered ${r.status}`);
        } catch (err) { log(`[bridge ${bot.name}] left ${prefixes.length} channel(s) but could not tell the proxy to drop its data: ${(err as Error).message}`); }
      })();
    });
    await client.login();
    ready.add(bot.name);
    clients.push({ bot, client });
    log(`[bridge] bot ${bot.name} is online (game ${bot.game}, scope ${bot.options.scope}, ${bot.channels === "all" ? "all channels" : `${bot.channels.length} channel(s)`}${bot.dms ? ", DMs" : ""})`);
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, bots: [...ready] })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.bridge.port, config.bridge.host, () => resolve()); });

  return {
    address: () => { const a = server.address(); return a && typeof a === "object" ? { host: a.address, port: a.port } : null; },
    ready: () => [...ready],
    async stop() {
      for (const t of timers) clearInterval(t);
      await new Promise<void>((r) => server.close(() => r()));
      for (const { client } of clients) { try { await client.destroy(); } catch { /* going away */ } }
    },
  };
}
