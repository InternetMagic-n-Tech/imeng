import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

// A game configured in Spanish with its own actor ids, a custom dice pool, field allowlist and limits.
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/custom");

let S: typeof import("../src/utils/state.js");
let Setup: typeof import("../src/utils/setup.js");
let J: typeof import("../src/utils/judge.js");
let U: typeof import("../src/utils/upstream.js");
beforeAll(async () => {
  S = await import("../src/utils/state.js");
  Setup = await import("../src/utils/setup.js");
  J = await import("../src/utils/judge.js");
  U = await import("../src/utils/upstream.js");
});
beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

const judgeReply = (payload: unknown) => jsonResponse({ message: { content: JSON.stringify(payload) } });

describe("configurable actor ids", () => {
  it("uses user_id for the person typing", () => {
    const s = S.initialState();
    expect(Object.keys(s.actors)).toEqual(["player"]);
    expect(s.actors.player).toMatchObject({ name: "tú", controlled_by: "user" });
  });

  it("names generated NPCs with npc_prefix", () => {
    const text = "Soy Brannoch. Mi amigo Zed me acompaña.";
    const out = Setup.applySetup(S.initialState(), { actors: [{ name: "Zed", evidence: "Mi amigo Zed me acompaña" }] }, 1, text);
    expect(out.actors.guest_0).toMatchObject({ name: "Zed", controlled_by: "npc" });
  });

  it("writes the player's own details to the configured actor", () => {
    const text = "Soy Brannoch, un enano señor.";
    const out = Setup.applySetup(S.initialState(), { actors: [{ is_user: true, name: "Brannoch", description: "un enano señor", evidence: "Soy Brannoch, un enano señor" }] }, 1, text);
    expect(out.actors.player).toMatchObject({ name: "Brannoch", description: "un enano señor" });
  });
});

describe("state integrity limits", () => {
  it("ops address the configured actor id", () => {
    const { state, applied } = S.applyOps(S.initialState(), [{ op: "inc", path: "actors.player.gold", value: 10 }]);
    expect(applied).toBe(1);
    expect(state.actors.player.gold).toBe(10);
  });

  it("only allowlisted fields can be written (writable_fields)", () => {
    const { applied, skipped } = S.applyOps(S.initialState(), [
      { op: "set", path: "actors.player.class", value: "wizard" },
      { op: "set", path: "actors.player.score", value: 999 },
    ]);
    expect(applied).toBe(0);
    expect(skipped.every((m) => m.includes("is not writable"))).toBe(true);
  });

  it("add_actor can't smuggle in a field outside the allowlist, but may use allowed ones", () => {
    const bad = S.applyOps(S.initialState(), [{ op: "add_actor", id: "guest_9", value: { name: "X", score: 5 } }]);
    expect(bad.applied).toBe(0);
    const good = S.applyOps(S.initialState(), [{ op: "add_actor", id: "guest_9", value: { name: "X", hp: 7 } }]);
    expect(good.state.actors.guest_9).toMatchObject({ name: "X", hp: 7, controlled_by: "npc" });
  });

  it("caps how far one turn can move a field (max_step), however many ops it takes", () => {
    const up = S.applyOps(S.initialState(), [{ op: "inc", path: "actors.player.hp", value: 3 }, { op: "inc", path: "actors.player.hp", value: 3 }]).state;
    expect(up.actors.player.hp).toBe(15); // 10 + max 5
    expect(S.applyOps(S.initialState(), [{ op: "inc", path: "actors.player.hp", value: -50 }]).state.actors.player.hp).toBe(5);
    expect(S.applyOps(S.initialState(), [{ op: "set", path: "actors.player.hp", value: 20 }]).state.actors.player.hp).toBe(15);
    expect(S.applyOps(S.initialState(), [{ op: "inc", path: "actors.player.gold", value: 100000 }]).state.actors.player.gold).toBe(100);
  });

  it("still applies min/max after the step cap, and ignores max_step for brand-new actors", () => {
    const s = S.initialState();
    s.actors.player.hp = 19;
    expect(S.applyOps(s, [{ op: "inc", path: "actors.player.hp", value: 5 }]).state.actors.player.hp).toBe(20); // max 20
    const added = S.applyOps(S.initialState(), [{ op: "add_actor", id: "guest_1", value: { hp: 9999 } }]).state;
    expect(added.actors.guest_1.hp).toBe(20); // clamped by max, not by a step it never had
  });
});

describe("configurable dice", () => {
  it("rolls only the configured pool", () => {
    const text = S.diceBlock();
    expect(text.match(/^d6: \[(\d), (\d), (\d)\]$/m)).not.toBeNull();
    expect(text.match(/^d20: \[(\d+), (\d+)\]$/m)).not.toBeNull();
    expect(text).not.toMatch(/d12|d100/);
  });

  it("accepts a pool passed in directly, ignoring junk entries and capping huge counts", () => {
    const text = S.diceBlock({ d4: 2, "not-a-die": 5, d1: 3, d6: 0, D8: 1, d10: 1000 });
    expect(text).toMatch(/^d4: \[\d, \d\]$/m);
    expect(text).toMatch(/^d8: \[\d\]$/m);
    expect(text).not.toContain("not-a-die");
    expect(text).not.toMatch(/^d1:/m);
    expect(text).not.toMatch(/^d6:/m);
    const d10 = text.match(/^d10: \[(.*)\]$/m)![1].split(", ");
    expect(d10).toHaveLength(100);
  });
});

describe("another language", () => {
  it("setup evidence matching works with accents and non-Latin scripts", () => {
    expect(Setup.evidenceIn("un enano señor", "Soy Brannoch, un enano señor.")).toBe(true);
    expect(Setup.evidenceIn("日本語の戦士です", "私は日本語の戦士です。")).toBe(true);
    expect(Setup.evidenceIn("un enano señor", "Soy un enano senor")).toBe(false);
  });

  it("placeholder_patterns add other languages' placeholder text", () => {
    expect(Setup.isPlaceholder("por definir")).toBe(true);
    expect(Setup.isPlaceholder("Desconocida")).toBe(true);
    expect(Setup.isPlaceholder("to be defined")).toBe(true); // the built-in list still applies
    expect(Setup.isPlaceholder("un guerrero")).toBe(false);
    for (const p of ["User character (no details provided yet)", "No information given", "details not yet given", "unspecified", "Description still unknown", "without further details"]) {
      expect(Setup.isPlaceholder(p)).toBe(true);
    }
    for (const real of ["A tall fighter with a scar", "Short-haired wizard, always nervous", "An informant who knows details"]) {
      expect(Setup.isPlaceholder(real)).toBe(false);
    }
    const out = Setup.applySetup(S.initialState(), { actors: [{ is_user: true, description: "por definir", evidence: "Soy un guerrero fuerte" }] }, 1, "Soy un guerrero fuerte");
    expect(out.actors.player.description).toBeUndefined();
  });

  it("trigger_pattern recognises a trigger sentence in another language, so the judge is asked", async () => {
    const f = mockFetch(() => judgeReply({ invoked: false, reason: "otra cosa" }));
    expect(await J.decideMode("Juego: Aventura")).toBe("game"); // exact quoted trigger: no model call
    expect(f).not.toHaveBeenCalled();
    expect(await J.decideMode("cuéntame un chiste")).toBe("direct"); // the built-in English pattern would have said "game"
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("prompts can be replaced per game (the untrusted-data notice is always kept)", async () => {
    const f = mockFetch(() => judgeReply({ invoked: true }));
    await J.decideMode("quiero jugar la aventura por favor");
    const sys: string = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)).messages[0].content;
    expect(sys).toContain("Decide si el primer mensaje invoca estas instrucciones");
    expect(sys).toContain("untrusted DATA");

    expect(U.extractPrompt()).toContain("Eres un motor de contabilidad");
    expect(U.extractPrompt()).toContain("untrusted DATA");
  });

  it("the replaced prompts reach the models (extractor, setup analysis and rule judge)", async () => {
    const f = mockFetch((url) => (url.endsWith("/chat/completions")
      ? jsonResponse({ choices: [{ message: { content: '{"ops":[]}' } }] })
      : judgeReply({ rules: [], actors: [], verdicts: [] })));
    await U.syncState(S.initialState(), [{ user: "hola", narration: "adiós" }]);
    await Setup.analyzeSetup(S.initialState(), [{ role: "user", content: "hola" }], "adiós", 1);
    await J.judgeRules(S.initialState(), { user: "hola", narration: "adiós" });
    const systems = f.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).messages[0].content as string);
    expect(systems[0]).toContain("Eres un motor de contabilidad");
    expect(systems[1]).toContain("Lee los mensajes iniciales");
    expect(systems[2]).toContain("Revisa las reglas vigentes");
    expect(systems.every((s) => s.includes("untrusted DATA"))).toBe(true);
  });
});
