import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge"); // transfer: covert; NPCs Brother and Rosa

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { KNOWLEDGE } = await import("../src/utils/config.js");
const J = await import("../src/utils/knowledge-judge.js");
const K = await import("../src/utils/knowledge.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");

const ollama = makeOllama();
type Who = { id: string; name: string };
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", PRIV = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", PRIV_BO = "cccccccc-3333-4333-8333-cccccccccccc";
const KEY = "chat:" + TABLE;
const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return { send: async (who: Who, text: string) => {
    log.push({ role: "user", content: text });
    const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", who.name).send({ messages: log });
    const content = res.body?.choices?.[0]?.message?.content;
    if (typeof content === "string") log.push({ role: "assistant", content });
    return res;
  } };
};
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };
const store = () => sessions.get(KEY)!.knowledge!;
const lastNarrator = (): string => JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
const TATTOO = { kind: "fact", text: "Bea has a tattoo on her shoulder.", about: "user", known_by: [], access: "never", watch: ["tattoo"] };

let table: ReturnType<typeof chat>, priv: ReturnType<typeof chat>;
const start = async () => {
  table = chat(TABLE); priv = chat(PRIV);
  await table.send(bea, "Let's play"); await settle();
  await table.send(bo, "I watch"); await settle();
  ollama.s.calls.length = 0;
};
const addTattoo = async () => { ollama.s.facts.push(TATTOO); await priv.send(bea, "I have a tattoo I hide"); await priv.send(bea, "yes"); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("tell: passing a fact on in a private chat", () => {
  it("an existing hidden fact passes to the named person only; the narrator holds it when they speak, not when the sender does", async () => {
    await start(); await addTattoo();
    ollama.s.facts.push({ kind: "tell", to: ["Bo"], medium: "whisper", fact: "f1", text: "" });
    const proposed = reply(await priv.send(bea, "I whisper my tattoo to Bo"));
    expect(proposed).toContain('passing "Bea has a tattoo on her shoulder." on to p_bo by whisper');
    expect(store().facts.find((f) => f.id === "f1")!.knownBy).toEqual([]); // nothing before the yes
    expect(reply(await priv.send(bea, "yes"))).toBe("Done: p_bo now knows it. Nobody else does.");
    expect(store().facts.find((f) => f.id === "f1")).toMatchObject({ knownBy: ["p_bo"], access: "roleplaying" });
    await table.send(bea, "I wave at the torch"); await settle();
    expect(lastNarrator()).not.toContain("tattoo");
    await table.send(bo, "I nod to Bea"); await settle();
    expect(lastNarrator()).toContain("Known only to Bo: Bea has a tattoo on her shoulder.");
    const patPriv = chat(PRIV_BO);
    expect(reply(await patPriv.send(bo, "notes"))).toContain("Bea has a tattoo on her shoulder.");
    const t = store().audit.find((a) => a.kind === "transfer")!;
    expect(t.detail).toBe("to=p_bo via=whisper");
    expect(JSON.stringify(store().audit)).not.toContain("tattoo");
  });

  it("new words passed to a character make a fact known to the sender and that character", async () => {
    await start();
    ollama.s.facts.push({ kind: "tell", to: ["Brother"], medium: "sign", fact: "", text: "Bea will leave before dawn." });
    expect(reply(await priv.send(bea, "I sign to the brother that I leave before dawn"))).toContain("a secret:");
    await priv.send(bea, "yes");
    expect(store().facts.find((f) => f.id === "f1")).toMatchObject({ knownBy: ["user", "npc_brother"], access: "roleplaying", about: "user" });
    await table.send(bea, "I ask Brother for the time"); await settle();
    expect(lastNarrator()).toContain("Known only to Bea, Brother: Bea will leave before dawn.");
  });

  it("fails closed: no real recipient, a dm note, or a repeat that adds nobody never reaches the narrator", async () => {
    await start(); await addTattoo();
    ollama.s.facts.push({ kind: "tell", to: ["Nobody"], medium: "whisper", fact: "f1" });
    expect(reply(await priv.send(bea, "I whisper to Nobody"))).toContain("NOT passed on");
    expect(sessions.get(KEY)!.room!.notes).toEqual([]);
    store().facts.find((f) => f.id === "f1")!.access = "dm";
    ollama.s.facts.push({ kind: "tell", to: ["Bo"], medium: "whisper", fact: "f1" });
    expect(reply(await priv.send(bea, "I whisper to Bo"))).toContain("NOT passed on");
    store().facts.find((f) => f.id === "f1")!.access = "roleplaying";
    store().facts.find((f) => f.id === "f1")!.knownBy = ["p_bo"];
    ollama.s.facts.push({ kind: "tell", to: ["Bo"], medium: "whisper", fact: "f1" });
    await priv.send(bea, "again to Bo");
    expect(reply(await priv.send(bea, "yes"))).toBe("They already knew it.");
  });

  it("no drops it; a fact forgotten before the yes says so", async () => {
    await start(); await addTattoo();
    ollama.s.facts.push({ kind: "tell", to: ["Bo"], medium: "glance", fact: "f1" });
    await priv.send(bea, "I glance at Bo");
    expect(reply(await priv.send(bea, "no"))).toContain("Dropped");
    expect(store().facts.find((f) => f.id === "f1")!.knownBy).toEqual([]);
    ollama.s.facts.push({ kind: "tell", to: ["Bo"], medium: "glance", fact: "f1" });
    await priv.send(bea, "I glance at Bo");
    store().facts.splice(store().facts.findIndex((f) => f.id === "f1"), 1);
    expect(reply(await priv.send(bea, "yes"))).toBe("That fact is gone, so nothing was passed on.");
  });

  it("transfer off: the judge is not offered tell, and a tell it returns anyway is not usable", async () => {
    const s: any = { room: newRoom(), snapshots: [], unsynced: [], tail: Promise.resolve() };
    const me = join(s.room, { userId: "u-bea", name: "Bea" }, MULTIPLAYER!, 0)!;
    const state: any = { game: {}, actors: { user: { name: "Bea" }, p_bo: { name: "Bo" } } };
    ollama.s.facts.push({ kind: "tell", to: ["Bo"], text: "x" });
    const off = { ...KNOWLEDGE!, transfer: "off" as const };
    expect(await J.privateKnowledge({ cfg: off, table: s, me, text: "I whisper to Bo", state })).toContain("NOT passed on");
    expect(JSON.stringify(ollama.calls("knowledge_fact")[0].body)).not.toContain('kind \\"tell\\"');
  });
});

describe("covert: what NPCs secretly pass to each other", () => {
  it("only real NPC-to-NPC acts are kept; they become facts only those NPCs know, with ids in the audit", async () => {
    await start();
    ollama.s.covert.push({ covert: [
      { from: "npc_brother", to: ["npc_rosa"], medium: "glance", about: "user", content: "Brother and Rosa agree to freeze Bea out." },
      { from: "user", to: ["npc_rosa"], content: "a real player cannot scheme here" },
      { from: "npc_brother", to: ["p_bo"], content: "a player is not a covert recipient" },
      { from: "npc_brother", to: ["npc_brother"], content: "not to themselves" },
      { from: "npc_rosa", to: ["npc_brother"], medium: "bogus", content: "Brother and Rosa agree to freeze Bea out." },
    ] });
    await table.send(bea, "I deal the cards"); await settle();
    const made = store().facts.filter((f) => f.createdBy === "game" && f.id !== "agenda");
    expect(made).toHaveLength(1); // the duplicate and the bad ones are dropped
    expect(made[0]).toMatchObject({ knownBy: ["npc_brother", "npc_rosa"], access: "roleplaying", about: "user" });
    const a = store().audit.find((x) => x.kind === "covert")!;
    expect(a.detail).toBe("from=npc_brother to=npc_rosa via=glance");
    expect(JSON.stringify(store().audit)).not.toContain("freeze");
    await table.send(bo, "I look at Rosa"); await settle();
    expect(lastNarrator()).toContain("Known only to Brother, Rosa: Brother and Rosa agree to freeze Bea out.");
    await table.send(bea, "I look at Bo"); await settle();
    expect(lastNarrator()).not.toContain("freeze Bea out");
  });

  it("at most covert_max acts a round, and nothing is asked with fewer than two NPCs", async () => {
    const s: any = { room: newRoom(), snapshots: [], unsynced: [], tail: Promise.resolve() };
    const state: any = { game: {}, actors: { a: { name: "A", controlled_by: "npc" }, b: { name: "B", controlled_by: "npc" }, c: { name: "C", controlled_by: "npc" } } };
    ollama.s.covert.push({ covert: ["a", "b", "c"].map((f, i) => ({ from: f, to: ["abc"[(i + 1) % 3]], content: `act ${i}` })) });
    expect(await J.covertActs({ cfg: { ...KNOWLEDGE!, covertMax: 2 }, session: s, state, narration: "x", turn: 1 })).toBe(2);
    expect(K.storeOf(s, KNOWLEDGE!).facts.filter((f) => f.createdBy === "game" && f.id !== "agenda")).toHaveLength(2);
    ollama.s.calls.length = 0;
    expect(await J.covertActs({ cfg: KNOWLEDGE!, session: s, state: { game: {}, actors: { a: state.actors.a } } as any, narration: "x", turn: 2 })).toBe(0);
    expect(ollama.s.calls).toHaveLength(0);
  });
});
