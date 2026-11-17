import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import type { Message, TextBasedChannel } from "discord.js";
import type { BotClient, DMessage, DiscordApi } from "./types.js";
import type { ResolvedBot } from "./config.js";

/** The real Discord connection (discord.js). Everything the bridge decides lives elsewhere; this only translates. Not covered by the automated tests (they fake Discord). */

function toDMessage(m: Message, replyAuthor?: string | null): DMessage {
  const ch: any = m.channel;
  return {
    id: m.id, channelId: m.channelId, guildId: m.guildId ?? null,
    authorId: m.author.id, authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username, authorIsBot: m.author.bot,
    content: m.content ?? "", createdAt: m.createdTimestamp,
    replyToId: m.reference?.messageId ?? null, replyToAuthorId: replyAuthor,
    mentions: [...m.mentions.users.keys()],
    attachments: [...m.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType ?? null, size: a.size })),
    isDM: ch.type === ChannelType.DM,
    parentChannelId: typeof ch.isThread === "function" && ch.isThread() ? ch.parentId : null,
  };
}

export function makeDiscordJsClient(bot: ResolvedBot): BotClient {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message],
  });
  const textChannel = async (id: string): Promise<TextBasedChannel & { messages: any; send: any; sendTyping: any }> => {
    const ch: any = await client.channels.fetch(id);
    if (!ch || typeof ch.send !== "function") throw new Error(`channel ${id} is not a text channel the bot can use`);
    return ch;
  };
  const api: DiscordApi = {
    async fetchHistory(channelId, limit) {
      const ch = await textChannel(channelId);
      const out: DMessage[] = [];
      let before: string | undefined;
      while (out.length < limit) {
        const page = await ch.messages.fetch({ limit: Math.min(100, limit - out.length), ...(before ? { before } : {}) });
        if (!page.size) break;
        for (const m of page.values()) out.push(toDMessage(m));
        before = page.last()?.id;
        if (page.size < 100) break;
      }
      return out;
    },
    async send(channelId, text, replyTo) {
      const ch = await textChannel(channelId);
      const m = await ch.send({ content: text, allowedMentions: { parse: [], repliedUser: false }, ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}) });
      return m.id;
    },
    async sendImage(channelId, bytes, name, replyTo) {
      const ch = await textChannel(channelId);
      const m = await ch.send({ files: [{ attachment: Buffer.from(bytes), name }], allowedMentions: { parse: [], repliedUser: false }, ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}) });
      return m.id;
    },
    async dm(userId, text) { const u = await client.users.fetch(userId); await u.send({ content: text, allowedMentions: { parse: [] } }); },
    async edit(channelId, messageId, text) { const ch = await textChannel(channelId); await ch.messages.edit(messageId, { content: text, allowedMentions: { parse: [] } }); },
    async kick(channelId, userId) { const ch: any = await client.channels.fetch(channelId); if (!ch?.permissionOverwrites) throw new Error("not a server channel"); await ch.permissionOverwrites.edit(userId, { ViewChannel: false, SendMessages: false }); },
    async unkick(channelId, userId) { const ch: any = await client.channels.fetch(channelId); if (!ch?.permissionOverwrites) return; await ch.permissionOverwrites.delete(userId); },
    async typing(channelId) { const ch = await textChannel(channelId); await ch.sendTyping(); },
  };
  return {
    get selfId() { return client.user?.id ?? ""; },
    api,
    onMessage(cb) {
      client.on("messageCreate", async (m) => {
        try {
          let replyAuthor: string | null = null;
          if (m.reference?.messageId) replyAuthor = (await m.fetchReference().catch(() => null))?.author.id ?? null;
          cb(toDMessage(m, replyAuthor));
        } catch (e) { console.warn(`[bridge ${bot.name}] could not read a message:`, (e as Error).message); }
      });
    },
    onLeave(cb) {
      const say = (ids: string[]): void => { try { if (ids.length) cb({ channelIds: ids }); } catch (e) { console.warn(`[bridge ${bot.name}] leave handler failed:`, (e as Error).message); } };
      client.on("guildDelete", (g) => say([...g.channels.cache.keys()]));
      client.on("channelDelete", (c) => say([c.id]));
      client.on("threadDelete", (t) => say([t.id]));
      client.on("threadMembersUpdate", (_added, removed, thread) => { if (removed.has(client.user?.id ?? "")) say([thread.id]); });
    },
    onJoin(cb) {
      client.on("guildCreate", (g) => cb({ channelIds: [...g.channels.cache.keys()] }));
      client.on("threadMembersUpdate", (added, _removed, thread) => { if (added.has(client.user?.id ?? "")) cb({ channelIds: [thread.id] }); });
    },
    async login() {
      await new Promise<void>((resolve, reject) => { client.once("clientReady", () => resolve()); client.login(bot.token).catch(reject); });
    },
    async destroy() { await client.destroy(); },
  };
}
