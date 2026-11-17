import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge");

const { KNOWLEDGE, MULTIPLAYER } = await import("../src/utils/config.js");
const K = await import("../src/utils/knowledge.js");
const J = await import("../src/utils/knowledge-judge.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");

const ollama = makeOllama();
const cfg = KNOWLEDGE!;
const state: any = { game: {}, actors: { user: { name: "Bea", controlled_by: "user" }, p_bo: { name: "Bo", controlled_by: "other_player" }, npc_a: { name: "A", controlled_by: "npc" }, npc_b: { name: "B", controlled_by: "npc" } } };
const mk = () => { const s: any = { room: newRoom(), snapshots: [], unsynced: [], tail: Promise.resolve() }; const me = join(s.room, { userId: "u-bea", name: "Bea" }, MULTIPLAYER!, 0)!; return { s, me }; };
const priv = (s: any, me: any, text: string, c = cfg) => J.privateKnowledge({ cfg: c, table: s, me, text, state });

beforeEach(() => { ollama.reset(); for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear(); });
afterEach(() => { jest.restoreAllMocks(); });

describe("private tell: edges", () => {
  it("confirm_facts off passes on at once; an unknown medium becomes whisper; a repeat says they knew", async () => {
    const { s, me } = mk();
    const k = K.storeOf(s, cfg);
    k.facts.push({ id: "f1", text: "Bea owes money.", about: "user", knownBy: [], access: "never", watch: [], discover: [], createdBy: "u-bea", createdTurn: 0 });
    const off = { ...cfg, confirmFacts: "off" as const };
    ollama.s.facts.push({ kind: "tell", to: ["npc_a", "B"], medium: "telepathy", fact: "f1" });
    expect(await priv(s, me, "tell them", off)).toBe("Done: npc_a, npc_b now know it.");
    expect(k.audit.find((a) => a.kind === "transfer")!.detail).toBe("to=npc_a,npc_b via=whisper");
    ollama.s.facts.push({ kind: "tell", to: ["npc_a"], fact: "f1" });
    expect(await priv(s, me, "again", off)).toBe("They already knew it.");
    ollama.s.facts.push({ kind: "tell", to: ["npc_a"], text: "Bea hides a key." });
    expect(await priv(s, me, "a new thing", off)).toBe("Saved as f2.");
  });

  it("a tell with nothing to pass on, or a fact the sender does not hold, is not usable", async () => {
    const { s, me } = mk();
    ollama.s.facts.push({ kind: "tell", to: ["npc_a"], fact: "f9", text: "" });
    expect(await priv(s, me, "x")).toContain("NOT passed on");
    ollama.s.facts.push({ kind: "tell", to: ["npc_a"] });
    expect(await priv(s, me, "x")).toContain("NOT passed on");
    ollama.s.facts.push({ kind: "tell", to: ["user"], text: "to myself" });
    expect(await priv(s, me, "x")).toContain("NOT passed on"); // the sender is not a recipient
  });
});

describe("trigger check: edges", () => {
  const base = () => { const { s } = mk(); const k = K.storeOf(s, cfg); k.facts.push({ id: "t", text: "t", about: "user", knownBy: [], access: "never", watch: [], discover: [{ kind: "action", when: "w" }], createdBy: "game", createdTurn: 0 }); return { s, k }; };
  it("does nothing without a store, a room or a live trigger; ignores a garbage answer", async () => {
    await J.checkTriggers({ cfg, session: { room: newRoom() } as any, state, lines: [], narration: "", turn: 1 });
    await J.checkTriggers({ cfg, session: { knowledge: { facts: [], pending: {}, audit: [], seq: 0 } } as any, state, lines: [], narration: "", turn: 1 });
    const { s, k } = base();
    k.facts[1].discover = []; // only the seeded fact is left and it has no trigger
    ollama.s.calls.length = 0;
    await J.checkTriggers({ cfg, session: s, state, lines: [], narration: "", turn: 1 });
    expect(ollama.s.calls).toHaveLength(0);
    k.facts[1].discover = [{ kind: "action", when: "w" }];
    ollama.s.triggers.push("garbage" as any);
    await J.checkTriggers({ cfg, session: s, state, lines: [], narration: "x", turn: 1 });
    ollama.s.triggers.push({ fired: [{ fact: "t", trigger: 5, evidence: "x" }, { fact: "zz", trigger: 0, evidence: "x" }, null], confirmed: [{ fact: "t", trigger: 0, evidence: "x" }] });
    await J.checkTriggers({ cfg, session: s, state, lines: [], narration: "x marks it", turn: 1 });
    expect(k.facts[1].revealed).toBeUndefined();
  });
});

describe("covert: edges", () => {
  it("a garbage answer, a full store and an unknown about/medium are handled", async () => {
    const { s } = mk();
    ollama.s.covert.push({ covert: "nope" as any });
    expect(await J.covertActs({ cfg, session: s, state, narration: "x", turn: 1 })).toBe(0);
    ollama.s.covert.push({ covert: [{ from: "npc_a", to: ["npc_b"], about: "ghost", medium: "bogus", content: "plan one" }] });
    expect(await J.covertActs({ cfg, session: s, state, narration: "x", turn: 1 })).toBe(1);
    const made = K.storeOf(s, cfg).facts.find((f) => f.text === "plan one")!;
    expect(made.about).toBe("npc_a");
    expect(K.storeOf(s, cfg).audit.find((a) => a.kind === "covert")!.detail).toContain("via=gesture");
    ollama.s.covert.push({ covert: [{ from: "npc_a", to: ["npc_b"], content: "plan two" }] });
    expect(await J.covertActs({ cfg: { ...cfg, maxFacts: 2 }, session: s, state, narration: "x", turn: 2 })).toBe(0); // store full
  });
  it("the judge writes the covert acts by default; covert_with main uses the narrator model", async () => {
    expect(cfg.covertWith).toBe("judge");
    const { s } = mk();
    ollama.s.covert.push({ covert: [{ from: "npc_a", to: ["npc_b"], content: "judge plan" }] });
    expect(await J.covertActs({ cfg, session: s, state, narration: "x", turn: 1 })).toBe(1);
    const viaJudge = ollama.calls("knowledge_covert").at(-1)!.body;
    expect(viaJudge.format).toBe("json"); // the native judge API, off the narrator's model
    expect(viaJudge.response_format).toBeUndefined();
    ollama.s.covert.push({ covert: [{ from: "npc_a", to: ["npc_b"], content: "main plan" }] });
    expect(await J.covertActs({ cfg: { ...cfg, covertWith: "main" }, session: s, state, narration: "x", turn: 2 })).toBe(1);
    expect(ollama.calls("knowledge_covert").at(-1)!.body.response_format).toBeTruthy();
  });
});
