import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/conditions");

const { initialState, applyOps } = await import("../src/utils/state.js");
const { evalCondition, conditionProblems, MAX_DEPTH } = await import("../src/utils/conditions.js");
const { checkConfig } = await import("../src/utils/config-schema.js");

const table = (rows: [number, number][]) => {
  const s = initialState();
  rows.forEach(([w, st], i) => { s.actors[i ? `p${i}` : "user"] = { name: `P${i}`, warmth: w, stain: st, statuses: [], history: [] }; });
  return s;
};

describe("condition trees", () => {
  it("fires the dual key only when both aggregates hold", () => {
    expect(applyOps(table([[3, 8], [2, 6]]), []).state.game.exited_game.map((e) => e.reason)).toEqual(["dual key", "dual key"]);
    expect(applyOps(table([[3, 8], [9, 6]]), []).state.game.exited_game).toEqual([]); // max warmth too high
    expect(applyOps(table([[3, 1], [2, 2]]), []).state.game.exited_game).toEqual([]); // avg stain too low
  });
  it("NOT inverts; an actor at 0 leaves by the per-actor rule and then no longer counts for the group", () => {
    const t = table([[0, 0], [9, 0]]);
    expect(evalCondition({ logic: "NOT", conditions: [{ aggregate: "min", field: "warmth", gt: 0 }] }, t)).toBe(true);
    const out = applyOps(t, []).state.game.exited_game;
    expect(out).toEqual([{ id: "user", reason: "out" }]);
  });
  it("mixes a game field into a per-actor rule", () => {
    const s = table([[9, 9], [9, 0]]);
    expect(applyOps(s, []).state.game.exited_game).toEqual([]);
    s.game.round = 3;
    expect(applyOps(s, []).state.game.exited_game.map((e) => e.id)).toEqual(["user"]);
  });
  it("aggregates skip people who are out, and missing data is false", () => {
    const s = table([[3, 8], [2, 6], [9, 0]]);
    s.game.exited_game.push({ id: "p2", reason: "left" });
    expect(evalCondition({ aggregate: "avg", field: "stain", gte: 7 }, s)).toBe(true);
    expect(evalCondition({ aggregate: "sum", field: "stain", eq: 14 }, s)).toBe(true);
    expect(evalCondition({ aggregate: "avg", field: "nope", gte: 0 }, s)).toBe(false);
    expect(evalCondition({ field: "game.nope", gte: 0 }, s)).toBe(false);
    expect(evalCondition({ field: "nope", gte: 0 }, s)).toBe(false);
    expect(evalCondition({ logic: "AND", conditions: [] }, s)).toBe(false);
    expect(evalCondition({ logic: "NOT", conditions: [] }, s)).toBe(false);
  });
  it("comparison operators: lt/gt/eq all must hold; lte+gte alone means either", () => {
    const s = table([[5, 0]]);
    const a = s.actors.user;
    expect(evalCondition({ field: "warmth", gt: 4, lt: 6 }, s, a)).toBe(true);
    expect(evalCondition({ field: "warmth", gt: 5, lt: 6 }, s, a)).toBe(false);
    expect(evalCondition({ field: "warmth", eq: 5 }, s, a)).toBe(true);
    expect(evalCondition({ field: "warmth", lte: 1, gte: 9 }, s, a)).toBe(false);
    expect(evalCondition({ field: "warmth", lte: 1, gte: 5 }, s, a)).toBe(true);
  });
  it("stops at the depth limit", () => {
    let c: any = { field: "warmth", gte: 0 };
    for (let i = 0; i <= MAX_DEPTH + 1; i++) c = { logic: "OR", conditions: [c] };
    expect(evalCondition(c, table([[5, 0]]))).toBe(false);
    expect(conditionProblems(c, false).join()).toContain("nested deeper");
  });
});

describe("top_count (a tie at the top)", () => {
  const tie = { field: "stain", aggregate: "top_count" as const, gte: 2 };
  it("counts the actors that share the highest value", () => {
    expect(evalCondition(tie, table([[9, 5], [9, 5], [9, 1]]))).toBe(true);
    expect(evalCondition(tie, table([[9, 5], [9, 4]]))).toBe(false);
    expect(evalCondition({ ...tie, gte: undefined, eq: 3 }, table([[9, 5], [9, 5], [9, 5]]))).toBe(true);
  });
  it("is part of the schema", () => {
    expect(checkConfig({ exit_group_when: [tie] }).errors).toEqual([]);
  });
});

describe("condition checks", () => {
  it("reports bad rules", () => {
    expect(conditionProblems(5, true)).toHaveLength(1);
    expect(conditionProblems({ logic: "XOR", conditions: [] }, true).join()).toContain("logic");
    expect(conditionProblems({ logic: "AND", conditions: [] }, true).join()).toContain("non-empty");
    expect(conditionProblems({ logic: "NOT", conditions: [{ field: "a", gt: 1 }, { field: "b", gt: 1 }] }, true).join()).toContain("exactly one");
    expect(conditionProblems({ field: "", }, true).join()).toContain("needs a field");
    expect(conditionProblems({ field: "a", gt: 1, share: 0.5 }, true).join()).toContain("only works in exit_group_when");
    expect(conditionProblems({ field: "a", gt: 1, share: 0.5, aggregate: "avg" }, false).join()).toContain("does nothing");
    expect(conditionProblems({ field: "a", gt: 1, share: 2 }, false).join()).toContain("share must be");
    expect(conditionProblems({ logic: "OR", conditions: [{ field: "a", gt: 1 }] }, true)).toEqual([]);
  });
  it("the schema accepts trees and rejects junk", () => {
    const ok = { exit_group_when: [{ logic: "AND", conditions: [{ aggregate: "avg", field: "x", gte: 1 }, { field: "y", lt: 3, share: 0.5 }] }] };
    expect(checkConfig(ok).errors).toEqual([]);
    expect(checkConfig({ exit_when: [{ logic: "AND", conditions: [{ aggregate: "median", field: "x", gte: 1 }] }] }).errors.length).toBeGreaterThan(0);
  });
});

describe("present and is", () => {
  const st = (): any => ({ game: { exited_game: [], mood: "calm", calc: { n: { a: 1, b: 3 } } }, actors: { a: { name: "A", goals: ["x"], tag: "red" }, b: { name: "B", goals: [], tag: "red" } } });
  it("test text and lists, for one actor or for everyone", () => {
    const s = st();
    expect(evalCondition({ field: "goals", present: true }, s, s.actors.a)).toBe(true);
    expect(evalCondition({ field: "goals", present: true }, s, s.actors.b)).toBe(false);
    expect(evalCondition({ field: "goals", present: true }, s)).toBe(false);
    expect(evalCondition({ field: "goals", present: true, share: 0.5 }, s)).toBe(true);
    expect(evalCondition({ field: "goals", present: false }, s, s.actors.b)).toBe(true);
    expect(evalCondition({ field: "tag", is: "red" }, s)).toBe(true);
    expect(evalCondition({ field: "tag", is: "blue" }, s)).toBe(false);
  });
  it("read game fields of any kind, and maps with an aggregate", () => {
    const s = st();
    expect(evalCondition({ field: "game.mood", is: "calm" }, s)).toBe(true);
    expect(evalCondition({ field: "game.mood", present: true }, s)).toBe(true);
    expect(evalCondition({ field: "game.calc.n", aggregate: "max", gte: 3 }, s)).toBe(true);
    expect(evalCondition({ field: "game.calc.n", aggregate: "min", gte: 3 }, s)).toBe(false);
  });
  it("count as a comparison in the doctor's check", () => {
    expect(conditionProblems({ field: "tag", is: "red" }, false)).toEqual([]);
    expect(conditionProblems({ field: "tag" }, false)[0]).toContain("present or is");
  });
});
