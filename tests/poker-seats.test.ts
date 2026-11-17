import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/deal");
const { minToPlay, dealtIn } = await import("../src/utils/poker-seats.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");

const st = (game: Record<string, unknown>, chips: Record<string, number>): any => ({
  game, actors: Object.fromEntries(Object.entries(chips).map(([id, c]) => [id, { chips: c, status: "in" }])),
});

describe("min_to_play", () => {
  it("is off by default, a number, or the big blind (with the blinds' own default and floor)", () => {
    expect(minToPlay(st({}, {}))).toBe(0);
    expect(minToPlay(st({ min_to_play: 25 }, {}))).toBe(25);
    expect(minToPlay(st({ min_to_play: "big_blind", big_blind: 20 }, {}))).toBe(20);
    expect(minToPlay(st({ min_to_play: "big_blind" }, {}))).toBe(10);
    expect(minToPlay(st({ min_to_play: "big_blind", big_blind: 1 }, {}))).toBe(2);
    expect(minToPlay(st({ min_to_play: "nonsense" }, {}))).toBe(0);
  });
  it("deals in anyone with chips when off, and only those at or over the minimum when on", () => {
    const off = st({}, { a: 3, b: 50, c: 0 });
    expect([dealtIn(off, "a"), dealtIn(off, "b"), dealtIn(off, "c")]).toEqual([true, true, false]);
    const on = st({ min_to_play: "big_blind", big_blind: 10 }, { a: 3, b: 10, c: 50 });
    expect([dealtIn(on, "a"), dealtIn(on, "b"), dealtIn(on, "c"), dealtIn(on, "table")]).toEqual([false, true, true, false]);
    on.actors.b.status = "sitting out";
    expect(dealtIn(on, "b")).toBe(false);
  });
  it("the server's deal skips a player below the minimum", async () => {
    const s: any = initialState();
    s.game.phase = "preflop";
    s.game.min_to_play = 10; s.game.big_blind = 10;
    s.actors.bo.chips = 4;
    const r: any = await runPhaseHook(s, "registration", "state");
    expect(r.actors.bo.hole).toEqual([]);
  });
});
