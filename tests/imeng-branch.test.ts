import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/loops");
const { initialState, applyOps, stateBlock } = await import("../src/utils/state.js");
const { imengToGame } = await import("../src/utils/config.js");

describe("the imeng branch of the state", () => {
  it("is shown to the narrator as imeng and accepted in op paths, with game still working", () => {
    const st: any = initialState();
    const shown = stateBlock(st);
    expect(shown).toContain('"imeng": {');
    expect(shown).not.toContain('"game": {');
    const a = applyOps(st, [{ op: "set", path: "imeng.enemy_hp", value: 5 }]);
    expect(a.state.game.enemy_hp).toBe(5);
    const b = applyOps(st, [{ op: "set", path: "game.enemy_hp", value: 6 }]);
    expect(b.state.game.enemy_hp).toBe(6);
  });
  it("settings may name paths either way", () => {
    expect(imengToGame({ "imeng.phase": ["a"], ok: { path: "imeng.turn" }, text: "say imeng.phase in a sentence" })).toEqual({ "game.phase": ["a"], ok: { path: "game.turn" }, text: "say imeng.phase in a sentence" });
  });
});
