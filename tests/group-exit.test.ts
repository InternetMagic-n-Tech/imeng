import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/group-exit"); // exit_group_when

const { initialState, applyOps } = await import("../src/utils/state.js");

const group = (warmths: number[]) => {
  const s = initialState();
  warmths.forEach((w, i) => { s.actors[`p${i}`] = { name: `P${i}`, warmth: w, statuses: [], history: [] }; });
  s.actors.user.warmth = warmths[0];
  return s;
};

describe("exit_group_when", () => {
  it("ends the game for everyone when all are at or under the line", () => {
    const s = applyOps(group([2, 1, 0]), []).state;
    expect(s.game.exited_game.map((e) => e.id).sort()).toEqual(["p0", "p1", "p2", "user"]);
    expect(s.game.exited_game[0].reason).toBe("all frozen");
    expect(s.game.current_actor).toBeNull();
  });

  it("does nothing while one actor is still above the line", () => {
    expect(applyOps(group([2, 1, 5]), []).state.game.exited_game).toEqual([]);
  });

  it("honours share: most (60%) at 8 or over ends it, fewer does not", () => {
    const s = applyOps(group([9, 8, 10, 5]), []).state; // user=9, p0..p3 = 9,8,10,5: 4 of 5
    expect(s.game.exited_game[0].reason).toBe("most toasty");
    expect(applyOps(group([9, 3, 4, 5]), []).state.game.exited_game).toEqual([]);
  });

  it("ignores actors who are already out when counting the group", () => {
    const s = group([1, 9]); // user=1, p0=1, p1=9
    s.game.exited_game.push({ id: "p1", reason: "died" });
    const out = applyOps(s, []).state.game.exited_game;
    expect(out.map((e) => e.id).sort()).toEqual(["p0", "p1", "user"]);
  });

  it("does not re-exit actors who are already out, and ignores a rule on a field nobody has", () => {
    const s = group([1, 1]);
    s.game.exited_game.push({ id: "p0", reason: "left" });
    const out = applyOps(s, []).state.game.exited_game;
    expect(out.filter((e) => e.id === "p0")).toHaveLength(1);
    expect(out).toHaveLength(3);
  });
});
