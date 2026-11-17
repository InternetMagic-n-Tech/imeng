import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/multiplayer"); // multiplayer on, no setup turns

const { app } = await import("../src/app.js");
const { sessions, loadSessions } = await import("../src/utils/sessions.js");
const { seats, seatOf, _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
type Who = { id: string; name: string } | null;
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" }, cy: Who = { id: "u-cy", name: "Cy" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DAY = 86_400_000;

/** One Open WebUI chat: every request carries the whole chat so far, and each reply is saved into it, as Open WebUI does. */
const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return {
    log,
    send: async (who: Who, text: string, extra: object = {}) => {
      log.push({ role: "user", content: text });
      const r = request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id);
      if (who) r.set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", encodeURIComponent(who.name));
      const res = await r.send({ messages: log, ...extra });
      const content = res.body?.choices?.[0]?.message?.content;
      if (typeof content === "string") log.push({ role: "assistant", content });
      return res;
    },
  };
};
const settle = async (key: string) => { await sessions.get(key)!.tail; await flushLogs(); };
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const narrations = () => ollama.calls("narrator").length;
const KEY = "chat:" + TABLE;
/** Bea plays alone, then Bo speaks in the same shared chat: it is a table. */
const startTable = async () => {
  const t = chat(TABLE);
  await t.send(bea, "Let's play"); await settle(KEY);
  const second = await t.send(bo, "I follow her in");
  return { t, second };
};

beforeEach(() => {
  ollama.reset();
  ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("a chat shared with Allow replies is a table", () => {
  it("a second person speaking in the chat makes it a table; the story so far is the room's transcript, without the status lines", async () => {
    const { second } = await startTable();
    expect(reply(second)).toBe("Waiting for: Bea, Bo.");
    expect(narrations()).toBe(1);
    const room = sessions.get(KEY)!.room!;
    expect(room.order).toEqual(["u-bea", "u-bo"]);
    expect(room.history).toEqual([{ role: "user", content: "Let's play" }, { role: "assistant", content: "The torch flickers." }]);
    expect(room.rounds).toBe(1);
    expect([...sessions.keys()]).toEqual([KEY]); // one game
    expect(seatOf("u-bea", Date.now(), DAY)).toBe(KEY);
    expect(seatOf("u-bo", Date.now(), DAY)).toBe(KEY);
  });

  it("both talk and say ready: one round is narrated for everybody, from the room's transcript", async () => {
    const { t } = await startTable();
    expect(reply(await t.send(bea, "I pick the lock"))).toBe("Waiting for: Bea, Bo.");
    expect(reply(await t.send(bea, "ready"))).toBe("Ready: Bea. Waiting for: Bo.");
    expect(narrations()).toBe(1); // no model call while the table is not ready

    ollama.s.narration = "The lock clicks; the hall is empty.";
    ollama.s.extractor.push([{ op: "set", path: "actors.p_bo.hp", value: 6 }]);
    const done = await t.send(bo, "ready");
    expect(reply(done)).toBe("The lock clicks; the hall is empty."); // the shared chat shows it to everyone: no recap block
    await settle(KEY);
    const narrator = ollama.calls("narrator").at(-1)!.body;
    expect(narrator.messages.at(-1).content).toBe("[Bo (actors.p_bo)] I follow her in\n[Bea (actors.user)] I pick the lock"); // in the order they spoke
    expect(narrator.messages.filter((m: any) => m.role === "user")).toHaveLength(2); // the story so far, and this round: no "Waiting for" lines
    expect(JSON.stringify(narrator.messages)).not.toContain("Waiting for");
    const st = sessions.get(KEY)!.snapshots.at(-1)!;
    expect(st.game.turn).toBe(2);
    expect(st.actors.user).toMatchObject({ name: "Bea", controlled_by: "user" });
    expect(st.actors.p_bo).toMatchObject({ name: "Bo", controlled_by: "other_player", hp: 6 });
    expect(ollama.calls("extractor").at(-1)!.body.messages[0].content).toContain("SEVERAL REAL PEOPLE PLAY THIS GAME");
  });

  it("names arrive URL-encoded from Open WebUI and are decoded", async () => {
    const t = chat(TABLE);
    await t.send(bea, "Let's play"); await settle(KEY);
    await t.send({ id: "u-zoe", name: "Zoë Ng" }, "hello");
    expect(sessions.get(KEY)!.room!.players["u-zoe"].name).toBe("Zoë Ng");
  });

  it("a channel works the same: its chat id is channel:<id>", async () => {
    const c = chat("channel:abc");
    await c.send(bea, "start"); await settle("chat:channel:abc");
    const res = await c.send(bo, "me too");
    expect(reply(res)).toBe("Waiting for: Bea, Bo.");
    expect(sessions.get("chat:channel:abc")!.room!.order).toEqual(["u-bea", "u-bo"]);
  });

  it("without Open WebUI's user id nobody can be told apart: it stays an ordinary chat", async () => {
    const c = chat("plain");
    await c.send(null, "hello"); await settle("chat:plain");
    const res = await c.send(null, "hello again");
    expect(reply(res)).toBe("The torch flickers.");
    expect(sessions.get("chat:plain")!.room).toBeUndefined();
  });

  it("a gated answer is streamed when asked, and a person can leave the table", async () => {
    const { t } = await startTable();
    const res = await t.send(bea, "wait for me", { stream: true });
    expect(res.text).toContain("Waiting for: Bea, Bo.");
    expect(res.text).toContain("data: [DONE]");
    expect(reply(await t.send(bo, "leave the table"))).toBe("Bo has left the table.");
    expect(seats.has("u-bo")).toBe(false);
    expect(sessions.get(KEY)!.room!.players["u-bo"].away).toBeDefined();
  });

  it("the table, its players and its seats survive a restart", async () => {
    const { t } = await startTable();
    await t.send(bea, "I wait");
    sessions.clear(); _resetSeats(); loadSessions();
    expect(reply(await t.send(bo, "I wait too"))).toContain("Waiting for: Bea, Bo.");
    expect(sessions.get(KEY)!.room!.order).toEqual(["u-bea", "u-bo"]);
    expect(sessions.get(KEY)!.owner).toEqual({ userId: "u-bea", name: "Bea" });
  });
});

describe("a private chat: a seated person's new chat with the game", () => {
  it("is a side channel to the narrator: a note is kept for the next round, marked private, and never shown to the table", async () => {
    const { t } = await startTable();
    const priv = chat("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
    const res = await priv.send(bo, "I put poison in Bea's cup");
    expect(reply(res)).toBe("Noted: the DM will weigh it in the next round. Only you can see this.");
    expect(narrations()).toBe(1); // a private note costs no narrator call by default
    expect(sessions.get(KEY)!.room!.notes).toEqual([{ userId: "u-bo", text: "I put poison in Bea's cup" }]);
    expect(sessions.get("chat:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb")!.privateFor).toBe(KEY);

    expect(reply(await t.send(bea, "I raise the cup"))).not.toContain("poison");
    await t.send(bea, "ready");
    ollama.s.narration = "Bea sips; a strange taste.";
    const done = await t.send(bo, "ready");
    expect(reply(done)).not.toContain("poison");
    await settle(KEY);
    const input = ollama.calls("narrator").at(-1)!.body.messages.at(-1).content as string;
    expect(input).toContain("[Bo (actors.p_bo)] PRIVATE, never reveal to the other players: I put poison in Bea's cup");
    expect(sessions.get(KEY)!.room!.notes).toEqual([]);
  });

  it("only a new chat of a seated person is private: a stranger's chat, and a seated person's own earlier chat, are ordinary games", async () => {
    await startTable();
    const stranger = chat("cccccccc-3333-4333-8333-cccccccccccc");
    expect(reply(await stranger.send(cy, "hello"))).toBe("The torch flickers.");
    expect(sessions.get("chat:cccccccc-3333-4333-8333-cccccccccccc")!.privateFor).toBeUndefined();
    // Bo already had a solo chat of his own before he sat at the table
    sessions.clear(); _resetSeats();
    const own = chat("dddddddd-4444-4444-8444-dddddddddddd");
    await own.send(bo, "my own game"); await settle("chat:dddddddd-4444-4444-8444-dddddddddddd");
    await startTable();
    expect(reply(await own.send(bo, "I go on"))).toBe("The torch flickers.");
  });

  it("a seat that was not used for seat_days no longer makes a new chat private", async () => {
    await startTable();
    const spy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 15 * DAY);
    const late = chat("eeeeeeee-5555-4555-8555-eeeeeeeeeeee");
    expect(reply(await late.send(bo, "hi"))).toBe("The torch flickers.");
    spy.mockRestore();
  });

  it("leaving the table from a private chat frees the chat and the seat", async () => {
    await startTable();
    const priv = chat("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
    await priv.send(bo, "a note");
    expect(reply(await priv.send(bo, "leave the table"))).toBe("You have left the table. Speak at it again whenever you want to come back.");
    expect(seats.has("u-bo")).toBe(false);
    expect(sessions.get(KEY)!.room!.players["u-bo"].away).toBeDefined();
  });

  it("'I need a break' in a private chat steps the person away, with no reason kept, and the table goes on without them", async () => {
    const { t } = await startTable();
    await t.send(bea, "I search the desk"); await t.send(bea, "ready");
    ollama.s.roomMessages.push({ kind: "pause" });
    const priv = chat("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
    expect(reply(await priv.send(bo, "I really need privacy for a while"))).toBe("You have stepped away; the table will not wait for you. Speak when you are back.");
    expect(JSON.stringify(sessions.get(KEY)!.room)).not.toContain("privacy");
    ollama.s.narration = "Bea finds a map.";
    const res = await t.send(bea, "ready");
    expect(reply(res)).toBe("Bea finds a map.");
    await settle(KEY);
    expect(ollama.calls("narrator").at(-1)!.body.messages.at(-1).content).toBe("NOTE: Away right now (their characters sit out): Bo.\n[Bo (actors.p_bo)] I follow her in\n[Bea (actors.user)] I search the desk"); // what Bo declared before leaving still counts
  });

  it("a standing instruction left in a private chat takes over when the table has waited too long", async () => {
    const { t } = await startTable();
    const base = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(base);
    ollama.s.roomMessages.push({ kind: "act", standing: { after_real: "5 days", after_game: null, action: "wings it with the manual" } });
    const priv = chat("ffffffff-6666-4666-8666-ffffffffffff");
    expect(reply(await priv.send(bea, "if I don't answer in 5 days, assume I wing it with the manual"))).toBe("Standing instruction saved. Only you and the DM can see it.");
    expect(sessions.get(KEY)!.room!.notes).toEqual([]); // an instruction is not a note
    await t.send(bo, "I wait for Bea"); await t.send(bo, "ready");
    now.mockReturnValue(base + 4 * DAY);
    expect(reply(await t.send(bo, "ready"))).toBe("Ready: Bo. Waiting for: Bea.");
    now.mockReturnValue(base + 6 * DAY);
    ollama.s.narration = "The hatch opens; Bea's character fumbles through the manual.";
    const res = await t.send(bo, "ready");
    expect(reply(res)).toContain("fumbles through the manual");
    await settle(KEY);
    expect(ollama.calls("narrator").at(-1)!.body.messages.at(-1).content).toBe("[Bo (actors.p_bo)] I follow her in\n[Bo (actors.p_bo)] I wait for Bea\n[Bea (actors.user)] (not heard from in 6 days; wings it with the manual)");
  });

  it("the same message typed at the table is public, so a standing instruction there is not accepted", async () => {
    const { t } = await startTable();
    ollama.s.roomMessages.push({ kind: "act", standing: { after_real: "5 days", after_game: null, action: "wings it" } });
    await t.send(bo, "if I don't answer in 5 days, assume I wing it");
    expect(sessions.get(KEY)!.room!.players["u-bo"].standing).toBeUndefined();
  });

  it("the judge being unreachable never blocks the game: messages are plain moves under the ready rule", async () => {
    const { t } = await startTable();
    ollama.s.judgeDown = true;
    expect(reply(await t.send(bea, "I wait"))).toBe("Waiting for: Bea, Bo.");
  });
});
