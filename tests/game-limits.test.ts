import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet");
const { initialState, applyOps } = await import("../src/utils/state.js");

beforeEach(() => { for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });
const set = (path: string, value: unknown) => applyOps(initialState(), [{ op: "set", path, value }]).state.game as Record<string, unknown>;

describe("limits on the game's own numbers (limits: {\"imeng.<field>\": {min, max, max_step}})", () => {
  it("clamps to min and max", () => {
    expect(set("game.big_blind", 9999).big_blind).toBe(50);
    expect(set("game.big_blind", -4).big_blind).toBe(2);
    expect(set("game.big_blind", 20).big_blind).toBe(20);
  });
  it("max_step bounds one turn's move from where the turn started, and the narrator is told", () => {
    const r = set("game.ante", 100);
    expect(r.ante).toBe(3);
    expect(String((r.blocked as string[])[0])).toContain("game.ante");
  });
  it("a path written game.imeng.<field> (a model's slip) means game.<field>", () => {
    const r = applyOps(initialState(), [{ op: "set", path: "game.imeng.big_blind", value: 12 }]);
    expect(r.applied).toBe(1);
    expect((r.state.game as Record<string, unknown>).big_blind).toBe(12);
  });
  it("derive: a game field follows another after every change, and nobody else can write it", () => {
    expect(set("game.small_blind", 4).stakes).toBe("standard");
    expect(set("game.big_blind", 20).stakes).toBe(2);
    expect(set("game.big_blind", 33).stakes).toBe("other");
    const r = applyOps(initialState(), [{ op: "set", path: "game.stakes", value: "hacked" }]);
    expect(r.applied).toBe(0);
    expect((r.state.game as Record<string, unknown>).stakes).toBe("standard");
  });
});
