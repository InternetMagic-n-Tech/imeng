import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/dating");
const ollama = makeOllama();
const { finaleRound } = await import("../src/utils/dating-turn.js");
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const state = (att: any, over: any = {}): any => ({
  game: { phase: "finale", exited_game: [], attraction: att, ...over },
  actors: {
    user: { name: "Bea", role: "contestant", age: 30, relationship: "single", controlled_by: "user" },
    npc_bo: { name: "Bo", role: "contestant", age: 31, relationship: "single", controlled_by: "npc" },
    npc_cy: { name: "Cy", role: "contestant", age: 29, relationship: "dating", controlled_by: "npc" },
  },
});

describe("the finale pairing", () => {
  it("crowns two eligible contestants who point at each other (the user in their own words, the NPC from attraction)", async () => {
    ollama.s.dating.push({ points: [{ from: "user", to: "npc_bo" }] });
    const st = state({ user: { npc_bo: 3 }, npc_bo: { user: 2 } });
    const note = await finaleRound(st, "[Bea]: I point at Bo!");
    expect(st.game.royals).toEqual(["npc_bo", "user"]);
    expect(note).toContain("Bo and Bea");
    expect(note).toContain("King and Queen");
    expect(note).toContain("runner-up prize"); // the game's own finale wording (dating.finale.pair)
  });
  it("crowns nobody when it is not mutual, or when one is not eligible, and runs only once", async () => {
    ollama.s.dating.push({ points: [{ from: "user", to: "npc_cy" }] });
    const st = state({ user: { npc_cy: 3 }, npc_cy: { user: 3 } });
    const note = await finaleRound(st, "I point at Cy");
    expect(st.game.royals).toEqual([]); // Cy is dating
    expect(note).toContain("nobody is crowned");
    expect(await finaleRound(st, "again")).toBe(""); // already decided
  });
  it("only runs in the finale phase, and a judge failure still ends in a code-decided result", async () => {
    const early = state({}, { phase: "playing" });
    expect(await finaleRound(early, "x")).toBe("");
    expect(early.game.royals).toBeUndefined();
    ollama.s.judgeDown = true;
    const st = state({ user: { npc_bo: 3 }, npc_bo: { user: 3 } });
    await finaleRound(st, "I point at Bo");
    expect(st.game.royals).toEqual([]); // no one could be read pointing: no crowning rather than a guess
  });
});
