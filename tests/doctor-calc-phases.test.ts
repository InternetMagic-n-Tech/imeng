import { describe, it, expect } from "@jest/globals";
import { calcPhaseProblems } from "../src/utils/doctor.js";

describe("doctor: calculated and phases", () => {
  it("accepts a sound setup", () => {
    expect(calcPhaseProblems({ calculated: { done: { count: "actors.*.goals", where: { done: true } }, top: { argmax: "done" } }, phases: { start: "a", a: { require: [{ field: "goals", present: true }], next: "b" }, b: { exit_when: { field: "game.calc.done", aggregate: "max", gte: 1 }, next: ["a"] } }, allowed_values: { "game.phase": ["a", "b"] } })).toEqual([]);
    expect(calcPhaseProblems({})).toEqual([]);
  });
  it("flags bad calculated values", () => {
    const p = calcPhaseProblems({ calculated: { a: { count: "goals" }, b: { sum: "later" }, c: { max: "actors.*.x", sum: "actors.*.x" }, d: { sum: "actors.*.x", where: {} }, e: { argmax: "nope" } } });
    expect(p.join("|")).toContain("calculated.a: count needs");
    expect(p.join("|")).toContain('calculated.b: "later"');
    expect(p.join("|")).toContain("calculated.c needs exactly one");
    expect(p.join("|")).toContain("calculated.d: where only works with count");
    expect(p.join("|")).toContain("calculated.e");
  });
  it("flags bad phases", () => {
    expect(calcPhaseProblems({ phases: [] as any })).toEqual(["phases must be an object"]);
    expect(calcPhaseProblems({ phases: { start: "x" } }).join("|")).toContain("at least one phase");
    const p = calcPhaseProblems({
      phases: { start: "zzz", texts: { oops: "x" }, a: { next: "gone", require: [{ field: "f" }], exit_when: { field: "game.calc.nope", gte: 1 } }, b: "no", c: { exit_when: { field: "x", gte: 1 } } },
      allowed_values: { "game.phase": ["a"] },
    }).join("|");
    expect(p).toContain('phases.start "zzz"');
    expect(p).toContain("phases.texts.oops");
    expect(p).toContain('phases.a.next: "gone"');
    expect(p).toContain("phases.a.require[0]");
    expect(p).toContain("game.calc.nope is not a calculated value");
    expect(p).toContain("phases.b must be an object");
    expect(p).toContain("phases.c has exit_when but no next");
    expect(p).toContain('does not list the phase "c"');
  });
  it("accepts routes with operations and a gate with a way out, and flags a gate without one", () => {
    const ok = { phases: { start: "a", a: { next: ["b"] }, b: { gated: true, max_rounds: 3, next: [{ to: "a", ops: [{ op: "set", path: "game.x", value: 1 }] }] } }, allowed_values: { "game.phase": ["a", "b"] } };
    expect(calcPhaseProblems(ok)).toEqual([]);
    const bad = calcPhaseProblems({ phases: { start: "a", a: { gated: true, next: [] }, b: { max_rounds: 2, next: [{ to: "a", ops: "no" }, { ops: [] }] } }, allowed_values: { "game.phase": ["a", "b"] } }).join("|");
    expect(bad).toContain("phases.a is gated but has no next route");
    expect(bad).toContain("phases.b.max_rounds only works with gated");
    expect(bad).toContain("a route needs");
    const gate = calcPhaseProblems({ phases: { start: "a", a: { next: ["b"] }, b: { gated: { blocks: ["idle", "sleep"], when: { field: "game.x", eq: 1 } }, max_rounds: "nope", next: ["a"] } }, allowed_values: { "game.phase": ["a", "b"] } }).join("|");
    expect(gate).toContain('"sleep" is not one of');
    expect(gate).toContain("max_rounds must be a number or a state path");
  });
});
