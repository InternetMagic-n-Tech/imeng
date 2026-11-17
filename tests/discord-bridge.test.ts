import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

const realFetch = globalThis.fetch; // the bridge talks to the proxy for real; only the models are faked
import { makeOllama } from "./fake-ollama.js";
import { FakeDiscord } from "./fake-discord.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/sync"); // sync.mode repair

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { runBridge, FRIENDLY_ERROR } = await import("../src/modules/discord/bridge/main.js");
const { resolveConfig } = await import("../src/modules/discord/bridge/config.js");

const ollama = makeOllama();
const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz123456";
const SELF = "900";
const KEY = (chan: string, user: string) => `chat:discord:bot1:${chan}:${user}`;

let proxy: http.Server, proxyUrl = "", discord: FakeDiscord, bridge: Awaited<ReturnType<typeof runBridge>> | null = null, fetchFn: typeof fetch = realFetch;
const logs: string[] = [];

const until = async (fn: () => boolean, ms = 4000): Promise<void> => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); } };
const start = async (botOver: object = {}) => {
  const cfg = await resolveConfig({ proxy: { url: proxyUrl }, bots: [{ name: "bot1", token: TOKEN, game: "tests/fixtures/sync", ...botOver }] });
  cfg.bridge.port = 0; // any free port
  discord = new FakeDiscord(SELF);
  bridge = await runBridge(cfg, { makeClient: () => discord, fetchFn: (...a) => fetchFn(...a), log: (l) => logs.push(l), typingEveryMs: 30, minEditMs: 0, joinsFile: null, kickCheckMs: 50, pollMs: 40 });
};
const answers = (chan: string, n: number) => until(() => discord.botMessages(chan).length >= n);
const settle = async (key: string) => { await sessions.get(key)?.tail; await flushLogs(); };
const narratorMessages = (i = -1) => ((ollama.calls("narrator").at(i) as any).body.messages as { role: string; content: string }[]);
const chat = (i = -1) => narratorMessages(i).filter((m) => m.role !== "system").map((m) => m.content);
const system = (i = -1) => narratorMessages(i)[0].content;

beforeEach(async () => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "asks to play" }; ollama.s.setup = { rules: [], actors: [] };
  ollama.s.narration = "The torch flickers as you step into the long stone corridor. Water drips somewhere ahead, and a cold draft carries the smell of old iron toward you.";
  sessions.clear(); logs.length = 0; fetchFn = realFetch;
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  proxy = http.createServer(app);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterEach(async () => { await bridge?.stop(); bridge = null; await new Promise<void>((r) => proxy.close(() => r())); jest.restoreAllMocks(); });

describe("a bot in a public channel", () => {
  it("answers a mention as a reply and shows typing; the conversation is the person's own (their id is in its key)", async () => {
    await start();
    const q = discord.say("c1", "111", "Bea", `<@${SELF}> Let's play`, { mentions: [SELF] });
    await answers("c1", 1);
    const a = discord.botMessages("c1")[0];
    expect(a.content).toBe(ollama.s.narration);
    expect(a.replyToId).toBe(q.id);
    expect(discord.typings).toBeGreaterThan(0);
    await settle(KEY("c1", "111"));
    const s = sessions.get(KEY("c1", "111"))!;
    expect(s.snapshots).toHaveLength(2);
    expect(chat()).toEqual(["Let's play"]);
    expect(logs.some((l) => l.includes("answered in") && l.includes("discord:bot1:c1:111"))).toBe(true);
  });

  it("a conversation continues: the next message carries the earlier pair, rebuilt from the channel", async () => {
    await start();
    discord.say("c1", "111", "Bea", `<@${SELF}> Let's play`, { mentions: [SELF] }); await answers("c1", 1); await settle(KEY("c1", "111"));
    discord.say("c1", "111", "Bea", `<@${SELF}> I go north`, { mentions: [SELF] }); await answers("c1", 2); await settle(KEY("c1", "111"));
    expect(chat()).toEqual(["Let's play", ollama.s.narration, "I go north"]);
    const s = sessions.get(KEY("c1", "111"))!;
    expect(s.prints).toHaveLength(2);
    expect(s.audit!.map((x) => x.kind)).toEqual(["turn", "turn"]); // in step: nothing detected or repaired
  });

  it("everyone has their own 1:1 conversation with it, even in the same channel", async () => {
    await start();
    discord.say("c1", "111", "Bea", `<@${SELF}> Bea's game`, { mentions: [SELF] }); await answers("c1", 1); await settle(KEY("c1", "111"));
    discord.say("c1", "222", "Bo", `<@${SELF}> Bo's game`, { mentions: [SELF] }); await answers("c1", 2); await settle(KEY("c1", "222"));
    expect(chat()).toEqual(["Bo's game"]);
    expect([...sessions.keys()].sort()).toEqual([KEY("c1", "111"), KEY("c1", "222")]);
  });

  it("ignores messages that are not for it", async () => {
    await start();
    discord.say("c1", "111", "Bea", "just chatting with the room");
    discord.say("c1", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF], channelId: "c1" });
    await answers("c1", 1);
    expect(ollama.calls("narrator")).toHaveLength(1);
  });

  it("a direct message needs no mention, and is its own conversation", async () => {
    await start();
    discord.say("dm1", "111", "Bea", "hello bot", { isDM: true, guildId: null });
    await answers("dm1", 1);
    await settle("chat:discord:bot1:dm:111");
    expect(sessions.has("chat:discord:bot1:dm:111")).toBe(true);
  });

  it("two quick messages from one person are answered one at a time, in order, the second knowing the first's answer", async () => {
    await start();
    discord.say("c1", "111", "Bea", `<@${SELF}> one`, { mentions: [SELF] });
    discord.say("c1", "111", "Bea", `<@${SELF}> two`, { mentions: [SELF] });
    await answers("c1", 2); await settle(KEY("c1", "111"));
    expect(ollama.calls("narrator")).toHaveLength(2);
    expect(chat(0)).toEqual(["one"]);
    expect(chat(1)).toEqual(["one", ollama.s.narration, "two"]);
  });
});

describe("a long answer", () => {
  it("is split into messages that all reply to the question, and the next turn puts it back together so the record stays in step", async () => {
    ollama.s.narration = "The corridor goes on and on, ".repeat(190); // about 5,500 characters
    await start();
    const q = discord.say("c1", "111", "Bea", `<@${SELF}> tell me everything`, { mentions: [SELF] });
    await until(() => discord.botMessages("c1").length >= 3 && logs.some((l) => l.includes("answered in")));
    const pieces = discord.botMessages("c1");
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces.every((p) => p.replyToId === q.id && p.content.length <= 2000)).toBe(true);
    await settle(KEY("c1", "111"));
    discord.say("c1", "111", "Bea", `<@${SELF}> and then?`, { mentions: [SELF] });
    await until(() => ollama.calls("narrator").length >= 2);
    await until(() => logs.filter((l) => l.includes("answered in")).length >= 2);
    await settle(KEY("c1", "111"));
    expect(chat()).toHaveLength(3);
    expect(sessions.get(KEY("c1", "111"))!.audit!.some((a) => ["detected", "replay", "rebuild"].includes(a.kind))).toBe(false); // the pieces joined back into the same reply
  });
});

describe("what people do in Discord that Open WebUI has no word for", () => {
  it("an edited earlier message is noticed on the next turn and the record is repaired from the channel", async () => {
    await start();
    const msgs: any[] = [];
    for (const t of ["Let's play", "I go north", "I open the door"]) { msgs.push(discord.say("c1", "111", "Bea", `<@${SELF}> ${t}`, { mentions: [SELF] })); await answers("c1", msgs.length); await settle(KEY("c1", "111")); }
    msgs[1].content = `<@${SELF}> I go SOUTH instead`; // the edit
    const before = ollama.calls("extractor").length;
    discord.say("c1", "111", "Bea", `<@${SELF}> I look around`, { mentions: [SELF] });
    await answers("c1", 4); await settle(KEY("c1", "111"));
    const s = sessions.get(KEY("c1", "111"))!;
    expect(s.audit!.some((a) => a.kind === "replay")).toBe(true);
    expect((ollama.calls("extractor").slice(before) as any[]).some((c) => c.body.messages.at(-1).content.includes("I go SOUTH instead"))).toBe(true);
    expect(chat()).toContain("I go SOUTH instead");
  });

  it("a message that points at another person's exchange brings it along as background, not as part of the conversation", async () => {
    await start();
    discord.say("c1", "222", "Bo", `<@${SELF}> what is the capital of France?`, { mentions: [SELF] }); await answers("c1", 1); await settle(KEY("c1", "222"));
    discord.say("c1", "111", "Bea", `<@${SELF}> what did you tell <@222> earlier?`, { mentions: [SELF, "222"] }); await answers("c1", 2); await settle(KEY("c1", "111"));
    expect(system()).toContain("CONTEXT FROM THE INTERFACE");
    expect(system()).toContain("Earlier in this channel you spoke with Bo");
    expect(system()).toContain("what is the capital of France?");
    expect(chat()).toEqual(["what did you tell <@222> earlier?"]);
    expect(JSON.stringify(sessions.get(KEY("c1", "111"))!.prints)).not.toContain("France");
  });

  it("the bot's own settings reach the game on every turn", async () => {
    await start({ context: { symbol: "AAPL" } });
    discord.say("c1", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF] }); await answers("c1", 1);
    expect(system()).toContain('Bot settings: {"symbol":"AAPL"}');
  });
});

describe("when something goes wrong", () => {
  it("a proxy that cannot be reached gets a friendly reply, and the next message works again", async () => {
    await start();
    fetchFn = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    discord.say("c1", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF] });
    await answers("c1", 1);
    expect(discord.botMessages("c1")[0].content).toBe(FRIENDLY_ERROR);
    expect(logs.some((l) => l.includes("failed after"))).toBe(true);
    fetchFn = realFetch;
    discord.say("c1", "111", "Bea", `<@${SELF}> hello again`, { mentions: [SELF] });
    await answers("c1", 2);
    expect(discord.botMessages("c1")[1].content).toBe(ollama.s.narration);
  });

  it("a game that answers with an error (here: the narrator is down) is told to the person, not left silent", async () => {
    await start();
    ollama.s.narratorThrows = true;
    discord.say("c1", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF] });
    await answers("c1", 1);
    expect(discord.botMessages("c1")[0].content).toBe(FRIENDLY_ERROR);
  });

  it("a Discord failure while answering does not take the bridge down", async () => {
    await start();
    discord.failSend = true;
    discord.say("c1", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF] });
    await until(() => logs.some((l) => l.includes("failed after")));
    discord.failSend = false;
    discord.say("c1", "111", "Bea", `<@${SELF}> still there?`, { mentions: [SELF] });
    await answers("c1", 1);
  });
});

describe("the bridge process", () => {
  it("logs in every bot, answers the proxy's health check, and stops cleanly", async () => {
    await start();
    expect(discord.loggedIn).toBe(true);
    const a = bridge!.address()!;
    const res = await realFetch(`http://${a.host}:${a.port}/healthz`);
    expect(await res.json()).toEqual({ ok: true, bots: ["bot1"] });
    expect((await realFetch(`http://${a.host}:${a.port}/other`)).status).toBe(404);
    await bridge!.stop(); bridge = null;
    expect(discord.destroyed).toBe(true);
    await expect(realFetch(`http://${a.host}:${a.port}/healthz`)).rejects.toThrow();
  });
});

describe("joining and leaving", () => {
  it("never reads what was said before the bot joined, even when Discord hands it over", async () => {
    await start();
    discord.quietly("c9", "222", "Bo", `<@${SELF}> the secret is swordfish`, { mentions: [SELF] }); // said before the bot joined
    await new Promise((r) => setTimeout(r, 5));
    discord.join("c9");
    await new Promise((r) => setTimeout(r, 5));
    discord.say("c9", "111", "Bea", `<@${SELF}> hello there`, { mentions: [SELF] });
    await answers("c9", 1); await settle(KEY("c9", "111"));
    expect(JSON.stringify(narratorMessages())).not.toContain("swordfish");
  });

  it("when the bot is removed from a channel the proxy is told to drop everything under it", async () => {
    await start();
    const calls: { url: string; body: any }[] = [];
    fetchFn = (async (url: any, init?: any) => {
      if (String(url).endsWith("/admin/evict")) { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }
      return realFetch(url, init);
    }) as typeof fetch;
    discord.leave("c1", "c2");
    await until(() => calls.length === 1);
    expect(calls[0]!.body.prefixes).toEqual(["discord:bot1:c1", "discord:bot1:c2"]);
  });
});

describe("rejoining", () => {
  it("after being added, the first message it sees must be the launch word; 'ok' first keeps it dormant", async () => {
    await start();
    discord.join("c7");
    discord.say("c7", "111", "Bea", "ok");
    discord.say("c7", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF] });
    await new Promise((r) => setTimeout(r, 150));
    expect(discord.botMessages("c7")).toHaveLength(0);
    discord.join("c8");
    discord.say("c8", "111", "Bea", `<@${SELF}> hello`, { mentions: [SELF] });
    await answers("c8", 1);
  });
});

describe("removing a banned player from the channel", () => {
  it("hides the channel from them when the proxy says so, and gives it back when the ban ends", async () => {
    await start();
    const ends = Date.now() + 150;
    fetchFn = (async (url: any, init?: any) => {
      if (String(url).endsWith("/v1/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: "You are out." } }] }), { status: 200, headers: { "content-type": "application/json", "x-imeng-kick": `discord:111;${ends}` } });
      return realFetch(url, init);
    }) as typeof fetch;
    discord.say("c5", "111", "Bea", `<@${SELF}> I know his hand`, { mentions: [SELF] });
    await until(() => discord.kicked.length === 1);
    expect(discord.kicked[0]).toEqual({ channelId: "c5", userId: "111" });
    await until(() => discord.restored.length === 1); // the ban ended
    expect(discord.kicked).toEqual([]);
  });
});

describe("private notices by direct message", () => {
  it("sends what the proxy holds for a person as a DM and tells the proxy it was delivered", async () => {
    await start();
    const acked: any[] = [];
    let served = false;
    fetchFn = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes("/admin/announcements/ack")) { acked.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
      if (u.includes("/admin/announcements")) { const items = served ? [] : [{ key: `chat:discord:bot1:c1:u1`, id: "bust-1", to: "discord:777", text: "Your code is ABCD-EFGH." }, { key: "chat:discord:other:c1", id: "x", to: "discord:888", text: "not mine" }]; served = true; return new Response(JSON.stringify({ items }), { status: 200 }); }
      return realFetch(url, init);
    }) as typeof fetch;
    await until(() => discord.dms.length === 1);
    expect(discord.dms[0]).toEqual({ userId: "777", text: "Your code is ABCD-EFGH." });
    await until(() => acked.length === 1);
    expect(acked[0].items).toEqual([{ key: "chat:discord:bot1:c1:u1", id: "bust-1" }]);
  });
  it("a person who does not take DMs is left for the in-chat notice", async () => {
    await start();
    discord.failDm = true;
    const acked: any[] = [];
    fetchFn = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes("/ack")) { acked.push(1); return new Response("{}", { status: 200 }); }
      if (u.includes("/admin/announcements")) return new Response(JSON.stringify({ items: [{ key: "chat:discord:bot1:c1", id: "a", to: "discord:777", text: "hi" }] }), { status: 200 });
      return realFetch(url, init);
    }) as typeof fetch;
    await new Promise((r) => setTimeout(r, 200));
    expect(acked).toEqual([]);
  });
});
