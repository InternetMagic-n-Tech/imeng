import { describe, it, expect } from "@jest/globals";
import { goalProblems } from "../src/utils/doctor-goals.js";

describe("doctor: goals", () => {
  it("accepts a sound block and none at all", () => {
    expect(goalProblems({})).toEqual([]);
    expect(goalProblems({ goals: {} })).toEqual([]);
    expect(goalProblems({ goals: { device: "the Notebook", min: 1, max: 2, host: "own", reward: "points", score_field: "score", capture_phase: "registration", npc: "invent", standings: "end", reveal: "end", texts: { saved: "x" }, judge: { model: "big", url: "http://localhost:8080", api: "openai" } }, actor_template: { score: 0 }, phases: { registration: {} } })).toEqual([]);
  });
  it("flags every wrong value", () => {
    const p = goalProblems({ goals: { device: " ", min: 5, max: 2, host: "x", reward: "y", npc: "z", standings: "q", reveal: "r", capture_phase: "nope", texts: { bad: "x" }, judge: { api: "x", model: "", url: "ftp://x" } } }).join("|");
    for (const t of ["goals.device", "goals.min is above goals.max", "goals.host", "goals.reward", "goals.npc", "goals.standings", "goals.reveal", "goals.capture_phase needs phases", "goals.texts.bad", "goals.judge.api", "goals.judge.model", "goals.judge.url"]) expect(p).toContain(t);
  });
  it("checks the number ranges, the object shapes and what a reward needs", () => {
    expect(goalProblems({ goals: [] as any })).toEqual(["goals must be an object"]);
    expect(goalProblems({ goals: { min: 11 } }).join()).toContain("goals.min must be");
    expect(goalProblems({ goals: { max: 0 } }).join()).toContain("goals.max must be");
    expect(goalProblems({ goals: { judge: 1 as any } }).join()).toContain("goals.judge must be an object");
    expect(goalProblems({ goals: { reward: "keepsake" } }).join()).toContain("needs an images block");
    expect(goalProblems({ goals: { reward: "points", score_field: "bad field" } }).join()).toContain("goals.score_field must be a field name");
    expect(goalProblems({ goals: { reward: "points", score_field: "pts" }, actor_template: { score: 0 } }).join()).toContain('"pts" is not a field');
    expect(goalProblems({ goals: { capture_phase: "x" }, phases: { start: "a", a: {} } }).join()).toContain('"x" is not one of the phases');
  });
});
