import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/phases");
jest.spyOn(console, "log").mockImplementation(() => {});
jest.spyOn(console, "warn").mockImplementation(() => {});

const { initialState, applyOps } = await import("../src/utils/state.js");
const { phaseBlock } = await import("../src/utils/phases.js");
const { stateNotes } = await import("../src/utils/state.js");
const { evalCondition } = await import("../src/utils/conditions.js");

const goal = (done: boolean) => ({ text: "wear pink", done });
const give = (id: string, ...g: boolean[]) => g.map((d) => ({ op: "push", path: `actors.${id}.goals`, value: goal(d) }));
const calc = (s: any) => s.game.calc as Record<string, any>;

describe("calculated fields", () => {
  it("are computed by the server after every change", () => {
    let s = applyOps(initialState(), [...give("user", true, false), ...give("npc_bo", true, true)]).state;
    expect(calc(s).goals_done).toEqual({ user: 1, npc_bo: 2 });
    expect(calc(s).goals_total).toBe(3);
    expect(calc(s).most_done).toBe(2);
    expect(calc(s).leader).toBe("npc_bo");
  });
  it("give no leader on a tie, or when nobody reached the minimum", () => {
    const s = applyOps(initialState(), [...give("user", true), ...give("npc_bo", true)]).state;
    expect(calc(s).leader).toBeNull();
    expect(calc(applyOps(initialState(), []).state).leader).toBeNull();
    expect(calc(s).lowest_score).toBeNull(); // both at 0: tied
  });
  it("cannot be written by an op, whoever asks", () => {
    const r = applyOps(initialState(), [
      { op: "set", path: "game.calc", value: { leader: "user" } },
      { op: "set", path: "game.calc.leader", value: "user" },
      { op: "inc", path: "game.calc.goals_total", value: 5 },
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped.length).toBe(3);
    expect(calc(r.state).leader).toBeNull();
  });
  it("cannot be copied into a field through an address either", () => {
    const r = applyOps(initialState(), [{ op: "set", path: "actors.user.name", value: "game.calc.leader" }]);
    expect(r.applied).toBe(0);
    expect(r.skipped[0]).toContain("server-owned");
    expect(r.state.actors.user.name).toBe("Bea");
  });
  it("ignore a calculated value the model slipped into a state it rewrites", () => {
    const s = applyOps(initialState(), []).state;
    s.game.calc = { leader: "user" };
    expect(calc(applyOps(s, []).state).leader).toBeNull();
  });
  it("read in a condition, as a number or as a map with an aggregate", () => {
    const s = applyOps(initialState(), give("user", true)).state;
    expect(evalCondition({ field: "game.calc.goals_total", gte: 1 }, s)).toBe(true);
    expect(evalCondition({ field: "game.calc.goals_done", aggregate: "max", gte: 1 }, s)).toBe(true);
    expect(evalCondition({ field: "game.calc.goals_done", aggregate: "top_count", gte: 2 }, s)).toBe(false);
    expect(evalCondition({ field: "game.calc.nope", gte: 1 }, s)).toBe(false);
  });
  it("leave out exited actors", () => {
    const s = applyOps(initialState(), [...give("user", true), { op: "exit_actor", id: "npc_bo", reason: "gone" }]).state;
    expect(Object.keys(calc(s).goals_done)).toEqual(["user"]);
  });
});

describe("phases", () => {
  const set = (phase: string) => [{ op: "set", path: "game.phase", value: phase }];
  it("hold the game in registration until everyone has a goal, and say what is missing", () => {
    const r = applyOps(initialState(), [...give("user", false), ...set("playing")]);
    expect(r.state.game.phase).toBe("registration");
    expect((r.state.game.blocked as string[])[0]).toContain("playing");
    const text = phaseBlock(r.state);
    expect(text).toContain("registration phase");
    expect(text).toContain("every contestant needs a goal");
    expect(stateNotes(undefined, r.state)).toContain("did not allow");
  });
  it("let the model move on once the requirement holds", () => {
    const s = applyOps(initialState(), [...give("user", false), ...give("npc_bo", false)]).state;
    const r = applyOps(s, set("playing"));
    expect(r.state.game.phase).toBe("playing");
    expect(r.state.game.blocked).toBeUndefined();
    expect(phaseBlock(r.state)).not.toContain("until");
  });
  it("name who still lacks the field when the game gave no reason", () => {
    const text = phaseBlock(applyOps(initialState(), []).state);
    expect(text).toContain("every contestant needs a goal");
  });
  it("only move along next, never skip a step or go back", () => {
    let s = applyOps(initialState(), [...give("user", true), ...give("npc_bo", false)]).state;
    expect(applyOps(s, set("finale")).state.game.phase).toBe("registration");
    s = applyOps(s, set("playing")).state;
    expect(applyOps(s, set("registration")).state.game.phase).toBe("playing");
    expect(applyOps(s, set("nowhere")).state.game.phase).toBe("playing");
    expect(applyOps(s, [{ op: "set", path: "game.phase", value: 7 }]).state.game.phase).toBe("playing");
  });
  it("refuse to enter a phase whose enter_when is false", () => {
    let s = applyOps(initialState(), [...give("user", false), ...give("npc_bo", false)]).state;
    s = applyOps(s, set("playing")).state;
    expect(applyOps(s, set("finale")).state.game.phase).toBe("playing"); // nobody has done a goal
    s = applyOps(s, [{ op: "set", path: "actors.user.goals", value: [goal(true)] }]).state;
    expect(applyOps(s, set("finale")).state.game.phase).toBe("finale");
  });
  it("move on by themselves when exit_when holds", () => {
    let s = applyOps(initialState(), [...give("user", false), ...give("npc_bo", false)]).state;
    s = applyOps(s, set("playing")).state;
    s = applyOps(s, [{ op: "set", path: "actors.user.goals", value: [goal(true), goal(true)] }]).state;
    expect(s.game.phase).toBe("finale");
  });
  it("start in the first phase when the state has none or an unknown one", () => {
    const s = initialState();
    delete s.game.phase;
    expect(applyOps(s, []).state.game.phase).toBe("registration");
    s.game.phase = "limbo";
    expect(applyOps(s, []).state.game.phase).toBe("registration");
  });
});
