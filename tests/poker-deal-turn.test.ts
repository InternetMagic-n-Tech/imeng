import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/deal");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");

describe("deal: server", () => {
  it("entering preflop deals the seated players, keeps a sitting-out player out, and sets five cards face down", async () => {
    const s: any = initialState();
    s.game.phase = "preflop";
    const r: any = await runPhaseHook(s, "registration", "state");
    expect(r.actors.user.hole).toHaveLength(2);
    expect(r.actors.bo.hole).toHaveLength(2);
    expect(r.actors.cy.hole).toEqual([]);
    expect(r.actors.table.reserve).toHaveLength(5);
    expect(r.actors.table.board).toEqual([]);
    const all = [...r.actors.user.hole, ...r.actors.bo.hole, ...r.actors.table.reserve];
    expect(new Set(all).size).toBe(9); // no card twice
    expect(r.actors.table.dealt).toHaveLength(4);
  });
  it("each street turns the cards the server already set, in order, once", async () => {
    let s: any = initialState();
    s.game.phase = "preflop";
    s = await runPhaseHook(s, "registration", "state");
    const res = [...s.actors.table.reserve];
    s.game.phase = "flop"; s = await runPhaseHook(s, "preflop", "state");
    expect(s.actors.table.board).toEqual(res.slice(0, 3));
    s.game.phase = "turn"; s = await runPhaseHook(s, "flop", "state");
    s.game.phase = "river"; s = await runPhaseHook(s, "turn", "state");
    expect(s.actors.table.board).toEqual(res);
    expect(s.actors.table.reserve).toEqual([]);
    const again = await runPhaseHook({ ...s, game: { ...s.game, phase: "river" } }, "turn", "state");
    expect(again.actors.table.board).toEqual(res); // not shown twice
  });
});
