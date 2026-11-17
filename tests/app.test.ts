import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { app } from "../src/app.js";
import { sessions } from "../src/utils/sessions.js";
import { flushLogs } from "../src/utils/logger.js";
import { makeOllama } from "./fake-ollama.js";

const TRIGGER = "Game: Test Adventure";
const ollama = makeOllama();
const logLines = () => {
  const f = process.env.LOG_FILE!;
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const chat = (id: string | null, messages: object[], extra: object = {}) => {
  const r = request(app).post("/v1/chat/completions");
  if (id) r.set("x-openwebui-chat-id", id);
  return r.send({ messages, ...extra });
};
const settle = async (id: string) => { await sessions.get("chat:" + id)!.tail; await flushLogs(); };
const state = (id: string) => sessions.get("chat:" + id)!.snapshots.at(-1)!;
const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

beforeEach(() => {
  ollama.reset();
  ollama.s.invoke = { invoked: true, reason: "asks to play" };
  ollama.s.setup = { rules: [], actors: [] };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.dirname(process.env.LOG_FILE!), { recursive: true, force: true });
  // spies persist across tests, so clear their history each time
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
});

describe("simple routes", () => {
  it("lists the game's model", async () => {
    const res = await request(app).get("/v1/models");
    expect(res.body).toEqual({ object: "list", data: [{ id: "test-game", object: "model", owned_by: "me" }] });
  });

  it("waits for the background update, so a debug read right after a reply sees the recorded state", async () => {
    ollama.s.extractor.push([{ op: "set", path: "actors.user.name", value: "Zed" }]);
    await chat("dbg2", [u(TRIGGER)]); // no settle: the state is still being written
    const res = await request(app).get("/debug/state");
    expect(res.body["chat:dbg2"].state.actors.user.name).toBe("Zed");
    expect(res.body["chat:dbg2"].pending).toBe(false);
  });

  it("exposes per-session state for debugging", async () => {
    await chat("dbg", [u(TRIGGER)]);
    await settle("dbg");
    const res = await request(app).get("/debug/state");
    expect(res.body["chat:dbg"].state.game.turn).toBe(1);
    expect(res.body["chat:dbg"].unsynced).toBe(0);
  });
});

describe("game mode", () => {
  it("runs the whole turn: state injected, narration returned, state updated, saved and logged", async () => {
    ollama.s.extractor.push([{ op: "inc", path: "actors.user.hp", value: -3 }, { op: "push", path: "game.events", value: "A goblin struck you." }]);
    const res = await chat("g1", [u(TRIGGER)]);

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message).toEqual({ content: "The torch flickers." }); // reasoning stripped
    await settle("g1");

    const narrator = ollama.calls("narrator")[0].body;
    expect(narrator.model).toBe("gemma4:26b");
    const sys: string = narrator.messages[0].content;
    expect(narrator.messages[0].role).toBe("system");
    expect(sys).toContain("You are the narrator of a test game.");
    expect(sys).toContain("CURRENT GAME STATE");
    expect(sys).toContain("SESSION RULES IN EFFECT");
    expect(sys).toContain("## DICE");
    expect(narrator.messages[1]).toEqual(u(TRIGGER));

    expect(state("g1").actors.user.hp).toBe(7);
    expect(state("g1").game.events).toEqual(["A goblin struck you."]);
    expect(state("g1").game.turn).toBe(1);
    expect(sessions.get("chat:g1")!.mode).toBe("game");
    expect(fs.readdirSync(process.env.SAVE_DIR!).filter((f) => f.endsWith(".json"))).toHaveLength(1);

    const roles = logLines().filter((l) => l.session === "chat:g1").map((l) => l.role).sort();
    expect(roles).toEqual(["extractor", "narrator", "rule_judge", "setup_analysis"]);
    expect(logLines().every((l) => l.mode === "game")).toBe(true);
    expect(ollama.calls("invocation")).toHaveLength(0); // exact trigger needs no judge call
  });

  it("streams SSE to the client without reasoning", async () => {
    const res = await chat("g2", [u(TRIGGER)], { stream: true });
    expect(res.text).toContain("data: [DONE]");
    expect(res.text).not.toContain("reasoning");
    expect(res.text).toContain("torch");
    await settle("g2");
    expect(state("g2").game.turn).toBe(1);
  });

  it("starts a game from a fuzzy first message when the judge agrees", async () => {
    await chat("g3", [u("hey can we play the test adventure?")]);
    await settle("g3");
    expect(ollama.calls("invocation")).toHaveLength(1);
    expect(sessions.get("chat:g3")!.mode).toBe("game");
    expect(logLines().some((l) => l.role === "invocation" && l.session === "chat:g3" && l.mode === "game")).toBe(true); // held entry released
  });

  it("applies setup analysis in the opening turns only", async () => {
    ollama.s.setup = { rules: [], actors: [{ is_user: true, name: "Bo", description: "tall fighter", evidence: "I am Bo, a tall fighter" }] };
    const first = [u(TRIGGER)];
    const r1 = await chat("g4", first);
    await settle("g4");
    expect(ollama.calls("setup")).toHaveLength(1);
    expect(state("g4").actors.user.name).toBe("you"); // nothing said yet

    const second = [...first, a(r1.body.choices[0].message.content), u("I am Bo, a tall fighter")];
    const r2 = await chat("g4", second);
    await settle("g4");
    expect(state("g4").actors.user).toMatchObject({ name: "Bo", description: "tall fighter" });

    const third = [...second, a(r2.body.choices[0].message.content), u("onward")];
    await chat("g4", third);
    await settle("g4");
    expect(ollama.calls("setup")).toHaveLength(2); // setup_turns is 2 in the fixture
    expect(state("g4").game.turn).toBe(3);
  });

  it("rolls back to the earlier snapshot when a turn is regenerated", async () => {
    ollama.s.extractor.push([{ op: "set", path: "actors.user.hp", value: 7 }]);
    const m1 = [u(TRIGGER)];
    const r1 = await chat("g5", m1); await settle("g5");
    const m2 = [...m1, a(r1.body.choices[0].message.content), u("attack")];
    ollama.s.extractor.push([{ op: "set", path: "actors.user.hp", value: 2 }]);
    await chat("g5", m2); await settle("g5");
    expect(state("g5").actors.user.hp).toBe(2);

    ollama.s.extractor.push([{ op: "set", path: "actors.user.hp", value: 5 }]);
    await chat("g5", m2); await settle("g5"); // same messages again = regenerate
    const lastNarrator = ollama.calls("narrator").at(-1)!.body.messages[0].content as string;
    expect(lastNarrator).toContain('"hp": 7'); // narrator saw the turn-1 state, not the discarded hp 2
    expect(state("g5").actors.user.hp).toBe(5);
    expect(sessions.get("chat:g5")!.snapshots).toHaveLength(3);
  });

  it("keeps failed extractions and retries them with the next turn", async () => {
    ollama.s.extractor.push("garbage", "garbage", "garbage"); // turn 1: three failed attempts
    const m1 = [u(TRIGGER)];
    const r1 = await chat("g6", m1); await settle("g6");
    expect(sessions.get("chat:g6")!.unsynced).toHaveLength(1);
    expect(state("g6").actors.user.hp).toBe(10);

    ollama.s.extractor.push([{ op: "inc", path: "actors.user.hp", value: -4 }]);
    await chat("g6", [...m1, a(r1.body.choices[0].message.content), u("again")]); await settle("g6");
    const prompt = ollama.calls("extractor").at(-1)!.body.messages[1].content as string;
    expect(prompt).toContain("EXCHANGE 1");
    expect(prompt).toContain("EXCHANGE 2"); // both exchanges in one extraction
    expect(sessions.get("chat:g6")!.unsynced).toEqual([]);
    expect(state("g6").actors.user.hp).toBe(6);
  });

  it("clears unsynced exchanges when the conversation is rolled back", async () => {
    ollama.s.extractor.push("x", "x", "x");
    const m1 = [u(TRIGGER)];
    const r1 = await chat("g7", m1); await settle("g7");
    const m2 = [...m1, a(r1.body.choices[0].message.content), u("two")];
    await chat("g7", m2); await settle("g7");
    await chat("g7", m2); await settle("g7"); // regenerate turn 2: snapshots.length (3) > turn (2)
    expect(sessions.get("chat:g7")!.unsynced.length).toBeLessThanOrEqual(1);
  });

  it("lifts a rule after consecutive judge votes and announces it exactly once", async () => {
    const vote = [{ id: "fog", lift: true, evidence: "a boat arrived", reason: "escape found" }];
    ollama.s.verdicts.push(vote, vote);
    const m1 = [u(TRIGGER)];
    const r1 = await chat("g8", m1); await settle("g8");
    expect(state("g8").game.rules.fog.active).toBe(true);

    const m2 = [...m1, a(r1.body.choices[0].message.content), u("sail away")];
    const r2 = await chat("g8", m2); await settle("g8");
    expect(state("g8").game.rules.fog).toMatchObject({ active: false, announced: false });

    const m3 = [...m2, a(r2.body.choices[0].message.content), u("look around")];
    const r3 = await chat("g8", m3); await settle("g8");
    const sys3 = ollama.calls("narrator").at(-1)!.body.messages[0].content as string;
    expect(sys3).toContain("RULES JUST LIFTED");
    expect(sys3).toContain("escape found");
    expect(state("g8").game.rules.fog.announced).toBe(true);

    await chat("g8", [...m3, a(r3.body.choices[0].message.content), u("rest")]); await settle("g8");
    expect(ollama.calls("narrator").at(-1)!.body.messages[0].content).not.toContain("RULES JUST LIFTED");
  });

  it("warns when a game chat's saved state is gone mid-conversation, but not on a normal first turn", async () => {
    await chat("w1", [u(TRIGGER)]); await settle("w1");
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("No saved game"));
    await chat("w2", [u(TRIGGER), a("earlier narration"), u("keep going")]); await settle("w2");
    expect(console.warn).toHaveBeenCalledWith("No saved game for chat:w2; starting fresh mid-conversation.");
  });

  it("a hostile extractor answer can't hand the player to the narrator, replace actors, or break limits", async () => {
    ollama.s.extractor.push([
      { op: "set", path: "actors.user.controlled_by", value: "npc" },
      { op: "set", path: "actors.user", value: { name: "Hijacked", controlled_by: "npc", hp: 9999 } },
      { op: "add_actor", id: "npc_0", value: { name: "Impostor", controlled_by: "user" } },
      { op: "set", path: "game.rules.fog.active", value: false },
      { op: "set", path: "game.turn", value: 99 },
      { op: "inc", path: "actors.user.hp", value: 5000 },
      { op: "set", path: "actors.user.description", value: "z".repeat(5000) },
    ]);
    await chat("h1", [u(TRIGGER)]); await settle("h1");
    const s = state("h1");
    expect(s.actors.user).toMatchObject({ name: "you", controlled_by: "user", hp: 10 }); // hp clamped to the fixture's max of 10
    expect(s.actors.user.description).toBeUndefined();
    expect(s.actors.npc_0).toMatchObject({ name: "Impostor", controlled_by: "npc" }); // an actor, but never a real player
    expect(s.game.rules.fog.active).toBe(true);
    expect(s.game.turn).toBe(1);
    expect(console.warn).toHaveBeenCalledWith("skipped ops:", expect.stringContaining("server-owned"));
  });

  it("serializes concurrent requests for one session", async () => {
    const order: string[] = [];
    const m1 = [u(TRIGGER)];
    const [x, y] = await Promise.all([chat("g9", m1).then((r) => { order.push("a"); return r; }), chat("g9", m1).then((r) => { order.push("b"); return r; })]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    await settle("g9");
    expect(sessions.get("chat:g9")!.snapshots).toHaveLength(2);
  });

  it("survives a failing setup analysis and a failing rule judge", async () => {
    const original = ollama.fetchMock.getMockImplementation()!;
    ollama.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/chat")) throw new Error("judge down");
      return original(input, init);
    });
    const res = await chat("g10", [u(TRIGGER)]);
    expect(res.status).toBe(200);
    await settle("g10");
    expect(console.warn).toHaveBeenCalledWith("setup analysis failed:", "judge down");
    expect(state("g10").game.turn).toBe(1);
    ollama.fetchMock.mockImplementation(original);
  });

  it("answers 502 when the narrator model is unreachable", async () => {
    ollama.s.narratorThrows = true;
    const res = await chat("g11", [u(TRIGGER)]);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toBe("fetch failed");
    await settle("g11"); // the session lock is released even on failure
    ollama.s.narratorThrows = false;
    expect((await chat("g11", [u(TRIGGER)])).status).toBe(200);
  });

  it("falls back to a content-based session key when there is no chat-id header", async () => {
    const r1 = await chat(null, [u(TRIGGER)]);
    await new Promise((r) => setTimeout(r, 50));
    const reply = r1.body.choices[0].message.content;
    await chat(null, [u(TRIGGER), a(reply), u("go on")]);
    await new Promise((r) => setTimeout(r, 50));
    const hashKeys = [...sessions.keys()].filter((k) => k.startsWith("hash:"));
    expect(hashKeys).toHaveLength(1);
    expect(sessions.get(hashKeys[0])!.snapshots.length).toBeGreaterThanOrEqual(2);
  });
});

describe("direct mode", () => {
  it("passes plain chats straight through: no system prompt, no state, nothing stored", async () => {
    ollama.s.invoke = { invoked: false, reason: "just chat" };
    const res = await chat("d1", [u("Tell me a joke")]);
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("The torch flickers.");

    const sent = ollama.calls("narrator")[0].body;
    expect(sent.messages).toEqual([u("Tell me a joke")]); // untouched, nothing injected
    expect(sent.model).toBe("gemma4:26b");
    expect(sessions.get("chat:d1")!.mode).toBe("direct");
    expect(sessions.get("chat:d1")!.snapshots).toHaveLength(1);
    expect(ollama.calls("extractor")).toHaveLength(0);
    expect(ollama.calls("rule_judge")).toHaveLength(0);
    await flushLogs();
    expect(logLines()).toEqual([]); // not even the invocation check
    expect(fs.readdirSync(process.env.SAVE_DIR!)).toEqual([]);
  });

  it("stays direct on later turns without asking again", async () => {
    ollama.s.invoke = { invoked: false, reason: "chat" };
    const r1 = await chat("d2", [u("hi")]);
    await chat("d2", [u("hi"), a(r1.body.choices[0].message.content), u("and another")]);
    expect(ollama.calls("invocation")).toHaveLength(1);
    expect(ollama.calls("narrator")).toHaveLength(2);
  });

  it("does not warn about 'starting fresh' for a direct chat the proxy has no record of", async () => {
    ollama.s.invoke = { invoked: false, reason: "chat" };
    await chat("d4", [u("hello"), a("hi"), u("second")]);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("No saved game"));
  });

  it("re-derives the mode from the first message when the session was forgotten", async () => {
    ollama.s.invoke = { invoked: false, reason: "chat" };
    await chat("d3", [u("hello"), a("hi"), u("second")]); // never saw turn 1 (e.g. after a restart)
    expect(sessions.get("chat:d3")!.mode).toBe("direct");
    expect(ollama.calls("invocation")).toHaveLength(1);
    expect(ollama.calls("extractor")).toHaveLength(0);
  });

  it("works for streaming and without a chat-id header", async () => {
    ollama.s.invoke = { invoked: false, reason: "chat" };
    const r1 = await chat(null, [u("hello")], { stream: true });
    expect(r1.text).toContain("data: [DONE]");
    expect([...sessions.keys()].some((k) => k.startsWith("hash:"))).toBe(true);
  });
});

describe("Open WebUI background tasks", () => {
  const task = [u("### Task:\nGenerate a title.")];

  it("is passed through and logged for a known game chat", async () => {
    await chat("b1", [u(TRIGGER)]); await settle("b1");
    const before = logLines().length;
    const res = await chat("b1", task);
    expect(res.status).toBe(200);
    expect(ollama.calls("narrator").at(-1)!.body.messages).toEqual(task); // no game prompt injected
    await flushLogs();
    const added = logLines().slice(before);
    expect(added.map((l) => l.role)).toEqual(["background"]);
    expect(added[0]).toMatchObject({ session: "chat:b1", mode: "game" });
  });

  it("is not logged for direct chats, unknown chats or when there is no chat id", async () => {
    ollama.s.invoke = { invoked: false, reason: "chat" };
    await chat("b2", [u("hello")]);
    await chat("b2", task);
    await chat("never-seen", task);
    await chat(null, task);
    await flushLogs();
    expect(logLines()).toEqual([]);
    expect(ollama.calls("narrator").filter((c) => (c.body.messages as any[])[0]?.content?.startsWith("### Task:"))).toHaveLength(3);
  });
});

describe("request handling", () => {
  it("copes with a body that has no messages", async () => {
    ollama.s.invoke = { invoked: false, reason: "empty" };
    const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "e1").send({});
    expect([200, 502]).toContain(res.status);
  });
});
