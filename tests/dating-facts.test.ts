import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/dating");
const ollama = makeOllama();
const { ensureNotes, revealRound, factsBlock, storeOf, revealedTo } = await import("../src/utils/dating-facts.js");
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const state = (): any => ({ game: { exited_game: [] }, actors: {
  user: { name: "Bea", role: "contestant", controlled_by: "user" },
  npc_bo: { name: "Bo", role: "contestant", controlled_by: "npc" } } });

describe("discovery", () => {
  it("writes private notes once per NPC, hidden from everyone", async () => {
    const s: any = {}; const st = state();
    await ensureNotes(s, st); await ensureNotes(s, st);
    expect(storeOf(s).facts.filter((f) => f.actor === "npc_bo").length).toBe(3);
    expect(storeOf(s).facts.every((f) => Array.isArray(f.to) && !f.to.length)).toBe(true);
  });
  it("reveals a fact only with a quote that is in the round", async () => {
    const s: any = {}; const st = state(); await ensureNotes(s, st);
    const id = storeOf(s).facts.find((f) => f.kind === "passion")!.id;
    ollama.s.datingReveals.push({ reveals: [{ id, to: "all", quote: "I made up this line" }] });
    expect(await revealRound(s, st, "Bo talks about the weather.")).toBe(0);
    ollama.s.datingReveals.push({ reveals: [{ id, to: ["user"], quote: "I love skydiving" }] });
    expect(await revealRound(s, st, "Bo: I love skydiving!")).toBe(1);
    expect(revealedTo(storeOf(s), "npc_bo", "user").length).toBe(1);
    expect(revealedTo(storeOf(s), "npc_bo", "npc_cy").length).toBe(0);
  });
  it("gives the narrator an NPC's notes only when that NPC is in the round", async () => {
    const s: any = {}; const st = state(); await ensureNotes(s, st);
    expect(factsBlock(s, st, "Bea waves at the crowd")).toBe("");
    expect(factsBlock(s, st, "Bea talks to Bo")).toContain("skydiving");
  });
});

describe("NPC relationship status", () => {
  it("is rolled once by code, locked, and follows the odds", async () => {
    const { rollStatus } = await import("../src/utils/dating-facts.js");
    const odds = { single: 0.7, dating: 0.2, married: 0.1 };
    expect([rollStatus(odds, () => 0), rollStatus(odds, () => 0.75), rollStatus(odds, () => 0.99)]).toEqual(["single", "dating", "married"]);
    const s: any = {}; const st = state();
    await ensureNotes(s, st, () => 0.95);
    expect(st.actors.npc_bo.relationship).toBe("married");
    expect(st.game.locked["npc_bo.relationship"]).toBe(true);
    await ensureNotes(s, st, () => 0); // already locked: not rolled again
    expect(st.actors.npc_bo.relationship).toBe("married");
  });
});
