import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge");

const { KNOWLEDGE } = await import("../src/utils/config.js");
const K = await import("../src/utils/knowledge.js");
const J = await import("../src/utils/knowledge-judge.js");
const T = await import("../src/utils/knowledge-turn.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");

const ollama = makeOllama();
const cfg = KNOWLEDGE!;
const state: any = { game: {}, actors: { user: { name: "Bea" }, p_bo: { name: "Bo" }, npc_brother: { name: "Brother" } } };
const fact = (o: Record<string, unknown> = {}): any => ({ id: "f9", text: "The brother plans to sell the farm.", about: "npc_brother", knownBy: ["npc_brother"], access: "roleplaying", watch: ["sell the farm"], discover: [], createdBy: "game", createdTurn: 0, ...o });
const session = (): any => ({ snapshots: [], unsynced: [], room: newRoom(), tail: Promise.resolve() });

beforeEach(() => { ollama.reset(); for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear(); });
afterEach(() => { jest.restoreAllMocks(); });

describe("config", () => {
  it("defaults: player confirms, names match, statements need the owner, retry on a leak", () => {
    expect(cfg).toMatchObject({ confirmFacts: "player", match: "name", actionConfirm: "none", statementConfirm: "owner", candidateTurns: 3, leak: "retry", notesView: true, maxFacts: 60 });
    expect(cfg.confirm.test("Yes!")).toBe(true);
    expect(cfg.confirm.test("yes please do")).toBe(false); // a whole message
    expect(cfg.forget.exec("forget f3")![1]).toBe("f3");
    expect(cfg.seed.map((f) => f.id)).toEqual(["agenda"]);
  });
});

describe("store", () => {
  it("seeds once, mints unused ids, and stops at max_facts", () => {
    const s = session();
    const k = K.storeOf(s, cfg); K.storeOf(s, cfg);
    expect(k.facts.map((f) => f.id)).toEqual(["agenda"]);
    k.facts.push(fact({ id: "f1" }));
    expect(K.newId(k)).toBe("f2");
    const tiny = { ...cfg, maxFacts: 2 };
    expect(K.addFact(k, tiny, fact(), 1)).toContain("most facts");
    expect(k.facts).toHaveLength(2);
  });

  it("the audit is bounded and holds no text", () => {
    const k = K.storeOf(session(), { ...cfg, auditKeep: 20 });
    for (let i = 0; i < 30; i++) K.record(k, { ...cfg, auditKeep: 20 }, i, "x", "f1");
    expect(k.audit).toHaveLength(20);
  });
});

describe("what the narrator holds", () => {
  it("never and dm facts reach no model; a revealed one is announced once", () => {
    const k = K.storeOf(session(), cfg);
    k.facts.push(fact({ id: "n", access: "never", knownBy: [], text: "hidden mark" }), fact({ id: "d", access: "dm", text: "a private note" }));
    const text = "[Bea (actors.user)] hello Brother";
    expect(K.blockFor(k, cfg, state, text).text).not.toMatch(/hidden mark|private note/);
    k.facts[1].revealed = { turn: 2, announced: false };
    const b = K.blockFor(k, cfg, state, text);
    expect(b.text).toContain("JUST REVEALED");
    expect(b.text).toContain("hidden mark");
    K.markAnnounced(b.announce);
    expect(K.blockFor(k, cfg, state, text).text).toContain("KNOWN TO THE TABLE");
  });

  it("the budget cuts what is given, and a knower is found by name or actor id", () => {
    const k = K.storeOf(session(), cfg);
    k.facts.push(fact({ id: "a", knownBy: ["p_bo"], text: "x".repeat(300) }));
    expect(K.blockFor(k, cfg, state, "[Bo (actors.p_bo)] hi").included.map((f) => f.id)).toContain("a");
    expect(K.blockFor(k, { ...cfg, maxChars: 200 }, state, "[Bo (actors.p_bo)] hi").included.map((f) => f.id)).not.toContain("a");
    expect(K.blockFor(k, cfg, state, "nothing here").included).toEqual([]);
  });

  it("match judge: the judge names who speaks (it gets ids and knowers, never the text); a failing judge falls back to names", async () => {
    const s = session(); K.storeOf(s, { ...cfg, match: "judge" });
    ollama.s.matches.push({ speaking: ["agenda"] });
    const b = await J.knowledgeFor(s, { ...cfg, match: "judge" }, state, "the room is quiet");
    expect(b.included.map((f) => f.id)).toEqual(["agenda"]);
    expect(JSON.stringify(ollama.calls("knowledge_match")[0].body)).not.toContain("sell the farm");
    ollama.s.judgeDown = true;
    expect((await J.knowledgeFor(s, { ...cfg, match: "judge" }, state, "the room is quiet")).included).toEqual([]);
    expect((await J.knowledgeFor(s, { ...cfg, match: "judge" }, state, "Brother?")).included).toHaveLength(1);
  });
});

describe("leak scan", () => {
  it("quoted speech of a fact that can come out by a statement is not a leak; the same words outside quotes are", () => {
    const f = fact({ watch: ["tattoo"], discover: [{ kind: "statement", when: "he says it" }] });
    expect(K.leaksIn([f], 'Brother grins: "nice tattoo".')).toEqual([]);
    expect(K.leaksIn([f], "Brother thinks of her tattoo.")).toHaveLength(1);
    expect(K.leaksIn([fact({ watch: ["tattoo"] })], 'He says "tattoo".')).toHaveLength(1); // no statement trigger: any mention
  });

  it("without watch words, the longest words of the text are used; redact drops the giving-away sentences and never returns nothing", () => {
    const f = fact({ watch: [], text: "Marta secretly embezzled money" });
    expect(K.watchOf(f)).toContain("embezzled");
    expect(K.redact("It was calm. She embezzled it all. The end.", [f])).toBe("It was calm. The end.");
    expect(K.redact("She embezzled it.", [f])).toBe("…");
  });

  it("audit logs and delivers; off scans nothing; neither calls the model again", async () => {
    const k = K.storeOf(session(), cfg);
    const args = { k, included: [fact()], turn: 3, messages: [], body: {} };
    expect(await T.guardNarration("He will sell the farm.", { ...args, cfg: { ...cfg, leak: "audit" } })).toBe("He will sell the farm.");
    expect(k.audit.map((a) => a.kind)).toEqual(["leak"]);
    expect(await T.guardNarration("He will sell the farm.", { ...args, cfg: { ...cfg, leak: "off" } })).toBe("He will sell the farm.");
    expect(k.audit).toHaveLength(1);
    expect(ollama.calls("narrator")).toHaveLength(0);
    expect(T.holdsReply({ ...cfg, leak: "audit" }, [fact()])).toBe(false);
    expect(T.holdsReply(cfg, [])).toBe(false);
    expect(T.holdsReply(cfg, [fact()])).toBe(true);
  });

  it("redact mode redacts at once; a failing rewrite falls back to redact", async () => {
    const k = K.storeOf(session(), cfg);
    const args = { k, included: [fact()], turn: 3, messages: [], body: {} };
    expect(await T.guardNarration("He will sell the farm. He smiles.", { ...args, cfg: { ...cfg, leak: "redact" } })).toBe("He smiles.");
    ollama.s.narratorThrows = true;
    expect(await T.guardNarration("He will sell the farm. He nods.", { ...args, cfg })).toBe("He nods.");
    expect(k.audit.map((a) => a.kind)).toContain("leak-redacted");
  });
});

describe("rollback and expiry", () => {
  it("replaying a turn hides what came out then or later and drops its candidates", () => {
    const k = K.storeOf(session(), cfg);
    k.facts.push(fact({ id: "a", revealed: { turn: 4, announced: true } }), fact({ id: "b", revealed: { turn: 2, announced: true } }), fact({ id: "c", candidate: { trigger: 0, turn: 5, expires: 8 } }));
    expect(K.rollbackKnowledge(k, cfg, 3)).toBe(1);
    expect(k.facts.filter((f) => f.id !== "agenda").map((f) => !!f.revealed)).toEqual([false, true, false]);
    expect(k.facts.find((f) => f.id === "c")!.candidate).toBeUndefined();
  });

  it("a candidate nobody confirmed expires after candidate_turns", async () => {
    const s = session(); const room = s.room;
    join(room, { userId: "u-bea", name: "Bea" }, MULTIPLAYER!, 0);
    const k = K.storeOf(s, cfg);
    k.facts.push(fact({ id: "t", about: "user", discover: [{ kind: "statement", when: "said" }], candidate: { trigger: 0, turn: 2, expires: 5 } }));
    await J.checkTriggers({ cfg, session: s, state, lines: [], narration: "", turn: 6 });
    expect(k.facts.find((f) => f.id === "t")!.candidate).toBeUndefined();
    expect(k.audit.map((a) => a.kind)).toContain("expired");
  });

  it("a fact about an NPC has nobody to confirm it, so a statement reveals it at once; a trigger's own confirm wins over the game's", async () => {
    const s = session(); const k = K.storeOf(s, cfg);
    join(s.room, { userId: "u-bea", name: "Bea" }, MULTIPLAYER!, 0);
    k.facts.push(fact({ id: "t", discover: [{ kind: "statement", when: "he says it" }] }), fact({ id: "u", about: "user", discover: [{ kind: "action", when: "she shows it", confirm: "owner" }] }));
    ollama.s.triggers.push({ fired: [{ fact: "t", trigger: 0, evidence: "I sold it" }, { fact: "u", trigger: 0, evidence: "I sold it" }] });
    await J.checkTriggers({ cfg, session: s, state, lines: [], narration: "He said: I sold it.", turn: 3 });
    expect(k.facts.find((f) => f.id === "t")!.revealed).toBeDefined();
    const u = k.facts.find((f) => f.id === "u")!;
    expect(u.revealed).toBeUndefined();
    expect(u.candidate).toMatchObject({ trigger: 0, expires: 6 });
  });
});

describe("private messages: the other options", () => {
  it("confirm_facts off saves at once; a full store says so; the notes command can be turned off", async () => {
    const s = session(); const room = s.room;
    const me = join(room, { userId: "u-bea", name: "Bea" }, MULTIPLAYER!, 0)!;
    const off = { ...cfg, confirmFacts: "off" as const };
    ollama.s.facts.push({ kind: "fact", text: "Bea owes money.", about: "user", known_by: [], access: "never" });
    expect(await J.privateKnowledge({ cfg: off, table: s, me, text: "I owe money", state })).toBe("Saved as f1.");
    ollama.s.facts.push({ kind: "fact", text: "Bea owes more.", about: "user", known_by: [], access: "never" });
    expect(await J.privateKnowledge({ cfg: { ...off, maxFacts: 2 }, table: s, me, text: "more", state })).toContain("most facts");
    ollama.s.facts.push({ kind: "note" });
    expect(await J.privateKnowledge({ cfg: { ...cfg, notesView: false }, table: s, me, text: "notes", state })).toBeNull(); // not a command: an ordinary note
    expect(await J.privateKnowledge({ cfg, table: s, me, text: "", state })).toBeNull();
  });

  it("a nonsense judge answer is an error to the player, never a note to the narrator", async () => {
    const s = session(); const me = join(s.room, { userId: "u-bea", name: "Bea" }, MULTIPLAYER!, 0)!;
    ollama.s.facts.push({ kind: "fact", text: "" });
    expect(await J.privateKnowledge({ cfg, table: s, me, text: "I have a secret", state })).toContain("NOT passed on");
    ollama.s.facts.push("garbage");
    expect(await J.privateKnowledge({ cfg, table: s, me, text: "I have a secret", state })).toContain("NOT passed on");
  });
});
