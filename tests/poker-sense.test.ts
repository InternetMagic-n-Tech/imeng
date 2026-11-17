import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet-sense");
const S = await import("../src/utils/poker-sense.js");
const { SENSE } = await import("../src/utils/config.js");
const { npcAction } = await import("../src/utils/poker-npc.js");
const { act } = await import("../src/utils/poker-bet.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");

const lcg = (seed = 7): (() => number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

describe("win chance by sampling", () => {
  it("aces beat a random hand most of the time, seven-deuce rarely; ties share; a short deck gives 0.5", () => {
    expect(S.equity("holdem", ["As", "Ah"], [], 1, 300, lcg())).toBeGreaterThan(0.75);
    expect(S.equity("holdem", ["2c", "7d"], [], 1, 300, lcg())).toBeLessThan(0.45);
    expect(S.equity("holdem", ["As", "Ah"], [], 3, 300, lcg())).toBeLessThan(S.equity("holdem", ["As", "Ah"], [], 1, 300, lcg()));
    expect(S.equity("holdem", ["As", "Ah"], ["Ad", "Ac", "Ks"], 1, 100, lcg())).toBeGreaterThan(0.95);
    expect(S.equity("holdem", [], [], 1, 10)).toBe(0.5);
  });
  it("stud5 and omaha run", () => {
    expect(S.equity("stud5", ["As", "Ah", "Ad", "Kc", "Kd"], [], 1, 50, lcg())).toBeGreaterThan(0.9);
    expect(S.equity("omaha", ["As", "Ah", "Kd", "Kc"], [], 1, 30, lcg())).toBeGreaterThan(0.5);
  });
});

describe("does a play fit the odds", () => {
  it("fold, call, raise and check against the price", () => {
    // price = 10 / (30 + 10) = 0.25
    expect(S.verdict("fold", 0.8, 10, 30, 0.15, 0.3)).toBe("bad");
    expect(S.verdict("fold", 0.1, 10, 30, 0.15, 0.3)).toBe("good");
    expect(S.verdict("fold", 0.1, 0, 30, 0.15, 0.3)).toBe("bad"); // folding when a check is free
    expect(S.verdict("call", 0.05, 10, 30, 0.15, 0.3)).toBe("bad");
    expect(S.verdict("call", 0.5, 10, 30, 0.15, 0.3)).toBe("good");
    expect(S.verdict("raise", 0.1, 10, 30, 0.15, 0.3)).toBe("bluff");
    expect(S.verdict("raise", 0.7, 10, 30, 0.15, 0.3)).toBe("good");
    expect(S.verdict("check", 0.9, 0, 30, 0.15, 0.3)).toBe("good");
  });
});

const dealt = async (): Promise<any> => { const st: any = initialState(); st.actors.cy.status = "in"; st.game.phase = "preflop"; return runPhaseHook(st, "registration", "state"); };

describe("sense kept by act()", () => {
  it("is read from config.json", () => { expect(SENSE).toMatchObject({ margin: 0.15, window: 6, samples: 200, bluffBelow: 0.3 }); });
  it("every judged play lands in game.sense (a window of recent ones); a timeout fold is not judged", async () => {
    const s = await dealt(), id = s.game.current_actor as string;
    const need = s.game.bet_level - (s.actors[id].bet || 0);
    expect(act(s, id, need ? "call" : "check").ok).toBe(true);
    expect(String(s.game.sense[id].recent)).toHaveLength(1);
    const s2 = await dealt(), id2 = s2.game.current_actor as string;
    act(s2, id2, "fold", { noSense: true });
    expect(s2.game.sense?.[id2]).toBeUndefined();
  });
  it("a refused play is not judged", async () => {
    const s = await dealt(), id = s.game.current_actor as string;
    s.actors[id].bet = 0; s.game.bet_level = 10;
    expect(act(s, id, "check").ok).toBe(false); // it costs to call
    expect(s.game.sense?.[id]).toBeUndefined();
  });
  it("senseRatio waits for enough plays, then reads the share that fit", () => {
    const s: any = { game: { sense: { a: { recent: "gg" }, b: { recent: "gbbbb-" } } }, actors: {} };
    expect(S.senseRatio(s, "a")).toBeNull();
    expect(S.senseRatio(s, "b")).toBeCloseTo(0.2);
  });
});

describe("what a showdown shows, and who is told", () => {
  it("every seat dealt in sees a weak raiser caught and a strong raiser honest; nobody sees themselves", () => {
    const s: any = { game: { weak_raisers: ["a"], strong_raisers: ["b"] }, actors: {} };
    S.recordShowdown(s, ["a", "b", "c"], ["a", "b"]);
    expect(s.game.seen.b.a).toEqual({ bluffs: 1, honest: 0 });
    expect(s.game.seen.c.a).toEqual({ bluffs: 1, honest: 0 });
    expect(s.game.seen.c.b).toEqual({ bluffs: 0, honest: 1 });
    expect(s.game.seen.a?.a).toBeUndefined();
    S.recordShowdown(s, ["c"], ["a"]);
    expect(S.bluffRate(s, "c", "a")).toBe(1);
    expect(S.bluffRate(s, "c", "zz")).toBeNull();
    expect(S.bluffRate(s, "b", "a")).toBeNull(); // seen once only
  });
  it("the narrator's read names the player who plays against the odds and one caught bluffing, and is empty otherwise", () => {
    const s: any = { game: { sense: { a: { recent: "bbbbg" } }, seen: { v: { a: { bluffs: 3, honest: 0 } } } }, actors: { a: { name: "Bea" }, table: {} } };
    const b = S.senseBlock(s);
    expect(b).toContain("READ ON THE PLAYERS");
    expect(b).toContain("Bea has played against the odds in 4 of the last 5");
    expect(b).toContain("Bea has been caught bluffing at 3 showdowns");
    expect(S.senseBlock({ game: {}, actors: { a: { name: "Bea" } } } as any)).toBe("");
  });
});

describe("NPCs weigh it", () => {
  const facing = (extra: any): any => ({ game: { phase: "flop", variant: "holdem", bet_level: 20, big_blind: 10, npc_aggression: 1, last_raiser: "user", ...extra }, actors: { table: { pot: 60, board: ["Ks", "7d", "2h"] }, cy: { name: "Cy", controlled_by: "npc", chips: 300, bet: 0, status: "in", hole: ["9s", "8d"] }, user: { name: "Bea", status: "in" } } });
  it("calls a raiser it has seen caught bluffing, and folds to one who plays straight", () => {
    const base = facing({}), caught = facing({ seen: { cy: { user: { bluffs: 4, honest: 0 } } } }), straight = facing({ seen: { cy: { user: { bluffs: 0, honest: 4 } } } });
    const calls = (st: any): number => [0.99, 0.95, 0.9].filter((r) => npcAction(st, "cy", () => r) === "call").length;
    expect(calls(caught)).toBeGreaterThanOrEqual(calls(base));
    expect(calls(caught)).toBeGreaterThan(calls(straight));
  });
  it("calls one whose plays have not made sense, more readily than a sensible one", () => {
    const wild = facing({ sense: { user: { recent: "bbbbbb" } } }), sane = facing({ sense: { user: { recent: "gggggg" } } });
    const calls = (st: any): number => [0.99, 0.9].filter((r) => npcAction(st, "cy", () => r) === "call").length;
    expect(calls(wild)).toBeGreaterThanOrEqual(calls(sane));
  });
});
