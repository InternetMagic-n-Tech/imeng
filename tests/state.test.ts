import { describe, it, expect } from "@jest/globals";
import { initialState, applyOps, judgeView, stateBlock, diceBlock } from "../src/utils/state.js";
import type { GameState } from "../src/utils/types.js";

const fresh = (): GameState => initialState();

describe("initialState", () => {
  it("builds game, rules and the user actor from config.json", () => {
    const s = fresh();
    expect(s.game).toMatchObject({ turn: 0, current_actor: null, exited_game: [], events: [], location: "start" });
    expect(s.game.rules.charity).toMatchObject({ locked: true, active: true, lift_votes: 0 });
    expect(s.game.rules.fog.lift_hint).toBe("Lift if a way out is found.");
    expect(s.actors.user).toMatchObject({ name: "you", hp: 10, controlled_by: "user" });
  });

  it("returns an independent copy each call", () => {
    const a = fresh(); a.actors.user.hp = 1;
    expect(fresh().actors.user.hp).toBe(10);
  });
});

describe("applyOps", () => {
  it("set / inc / push / remove", () => {
    const { state, applied, skipped } = applyOps(fresh(), [
      { op: "set", path: "actors.user.name", value: "Bo" },
      { op: "inc", path: "actors.user.hp", value: -3 },
      { op: "push", path: "actors.user.statuses", value: "drunk" },
      { op: "push", path: "actors.user.statuses", value: "angry" },
      { op: "remove", path: "actors.user.statuses", value: "drunk" },
      { op: "set", path: "game.location", value: "cave" },
    ]);
    expect(applied).toBe(6);
    expect(skipped).toEqual([]);
    expect(state.actors.user).toMatchObject({ name: "Bo", hp: 7, statuses: ["angry"] });
    expect(state.game.location).toBe("cave");
  });

  it("set creates missing intermediate objects", () => {
    const { state } = applyOps(fresh(), [{ op: "set", path: "game.flags.door", value: true }]);
    expect((state.game.flags as { door: boolean }).door).toBe(true);
  });

  it("does not mutate its input", () => {
    const s = fresh();
    applyOps(s, [{ op: "inc", path: "actors.user.hp", value: -5 }]);
    expect(s.actors.user.hp).toBe(10);
  });

  it("add_actor defaults to an NPC and rejects duplicates", () => {
    const { state, skipped } = applyOps(fresh(), [
      { op: "add_actor", id: "npc_0", value: { name: "Eve" } },
      { op: "add_actor", id: "npc_0", value: { name: "Dup" } },
    ]);
    expect(state.actors.npc_0).toMatchObject({ name: "Eve", controlled_by: "npc", hp: null });
    expect(skipped[0]).toContain("bad/duplicate actor");
  });

  it("exit_actor records the reason and clears current_actor", () => {
    const start = fresh();
    start.game.current_actor = "user";
    const { state } = applyOps(start, [{ op: "exit_actor", id: "user", reason: "left" }]);
    expect(state.game.exited_game).toEqual([{ id: "user", reason: "left" }]);
    expect(state.game.current_actor).toBeNull();
  });

  it("exit_actor on someone who is already out changes nothing (no duplicate entry, original reason kept)", () => {
    const first = applyOps(fresh(), [{ op: "exit_actor", id: "user", reason: "too cold" }]).state;
    const again = applyOps(first, [{ op: "exit_actor", id: "user", reason: "left" }, { op: "exit_actor", id: "user", reason: "left" }]);
    expect(again.state.game.exited_game).toEqual([{ id: "user", reason: "too cold" }]);
    expect(again.applied).toBe(2); // not rejected, so the extractor isn't asked to retry
  });

  it("exit_actor without a reason uses an empty string", () => {
    const { state } = applyOps(fresh(), [{ op: "exit_actor", id: "user" }]);
    expect(state.game.exited_game[0].reason).toBe("");
  });

  it.each([
    [{ op: "set", path: "game.turn", value: 9 }, "server-owned"],
    [{ op: "set", path: "game.rules.fog.active", value: false }, "server-owned"],
    [{ op: "push", path: "game.exited_game", value: 1 }, "server-owned"],
    [{ op: "set", path: "secrets.x", value: 1 }, "bad path"],
    [{ op: "set", path: "actors.__proto__.x", value: 1 }, "bad path"],
    [{ op: "set", path: "actors..x", value: 1 }, "bad path"],
    [{ op: "inc", path: "actors.user.name", value: 1 }, "inc needs numbers"],
    [{ op: "inc", path: "actors.user.hp", value: "x" }, "inc needs numbers"],
    [{ op: "push", path: "actors.user.hp", value: 1 }, "push needs an array"],
    [{ op: "remove", path: "actors.user.hp", value: 1 }, "remove needs an array"],
    [{ op: "push", path: "actors.nobody.statuses", value: 1 }, "no such path"],
    [{ op: "add_actor", id: "__proto__" }, "bad/duplicate actor"],
    [{ op: "add_actor" }, "bad/duplicate actor"],
    [{ op: "exit_actor", id: "ghost" }, "unknown actor"],
    [{ op: "explode" }, "unknown op"],
  ])("skips invalid op %j", (op, message) => {
    const { applied, skipped } = applyOps(fresh(), [op]);
    expect(applied).toBe(0);
    expect(skipped[0]).toContain(message);
  });

  it("never lets an op change who controls an actor, or replace a whole actor", () => {
    const { applied, skipped } = applyOps(fresh(), [
      { op: "set", path: "actors.user.controlled_by", value: "npc" },
      { op: "set", path: "actors.user", value: { name: "Evil", controlled_by: "npc" } },
      { op: "set", path: "actors", value: {} },
      { op: "set", path: "game", value: {} },
    ]);
    expect(applied).toBe(0);
    expect(skipped.map((m) => m.split(": ").pop())).toEqual(["actors.user.controlled_by is server-owned", "actors.user must name a field of an actor", "bad path actors", "bad path game"]);
  });

  it("an added actor can't claim to be a real player", () => {
    const { state } = applyOps(fresh(), [{ op: "add_actor", id: "npc_0", value: { name: "Eve", controlled_by: "user" } }]);
    expect(state.actors.npc_0.controlled_by).toBe("npc");
  });

  it("rejects values that are too big, too deeply nested or not plain JSON", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const { applied, skipped } = applyOps(fresh(), [
      { op: "set", path: "actors.user.description", value: "x".repeat(2000) },
      { op: "push", path: "actors.user.history", value: "y".repeat(2000) },
      { op: "set", path: "actors.user.notes", value: deep },
      { op: "inc", path: "actors.user.hp", value: Infinity },
      { op: "set", path: "actors.user.hp", value: undefined },
      { op: "add_actor", id: "npc_0", value: { description: "z".repeat(2000) } },
    ]);
    expect(applied).toBe(0);
    expect(skipped.join("\n")).toMatch(/longer than 1000/);
    expect(skipped.join("\n")).toMatch(/nested too deeply/);
    expect(skipped.join("\n")).toMatch(/inc needs numbers/);
    expect(skipped.join("\n")).toMatch(/not plain JSON/);
    expect(applyOps(fresh(), [{ op: "set", path: "actors.user.notes", value: { a: { b: [1, 2, "ok"] } } }]).applied).toBe(1);
  });

  it("accepts at most 50 ops per answer and says how many it ignored", () => {
    const ops = Array.from({ length: 60 }, (_, i) => ({ op: "push", path: "game.events", value: `e${i}` }));
    const { applied, skipped } = applyOps(fresh(), ops);
    expect(applied).toBe(50);
    expect(skipped).toEqual(["10 op(s) beyond the limit of 50 per answer"]);
  });

  it("game.current_actor can only be null or an existing actor", () => {
    expect(applyOps(fresh(), [{ op: "set", path: "game.current_actor", value: "ghost" }]).applied).toBe(0);
    expect(applyOps(fresh(), [{ op: "set", path: "game.current_actor", value: "user" }]).state.game.current_actor).toBe("user");
    expect(applyOps(fresh(), [{ op: "set", path: "game.current_actor", value: null }]).applied).toBe(1);
  });

  it("game.current_actor accepts a path-style reference and stores the bare id", () => {
    const r = applyOps(fresh(), [{ op: "set", path: "game.current_actor", value: "actors.user" }]);
    expect(r.applied).toBe(1);
    expect(r.state.game.current_actor).toBe("user");
    expect(applyOps(fresh(), [{ op: "set", path: "game.current_actor", value: "actors.ghost" }]).applied).toBe(0);
  });

  it("truncates a long exit reason", () => {
    const { state } = applyOps(fresh(), [{ op: "exit_actor", id: "user", reason: "r".repeat(500) }]);
    expect(state.game.exited_game[0].reason).toHaveLength(200);
  });

  it("throws when ops is not an array", () => {
    expect(() => applyOps(fresh(), { op: "set" })).toThrow("ops is not an array");
  });

  it("clamps numeric fields to limits", () => {
    const { state } = applyOps(fresh(), [
      { op: "inc", path: "actors.user.hp", value: 50 },
      { op: "set", path: "actors.user.gold", value: -5 },
    ]);
    expect(state.actors.user.hp).toBe(10);
    expect(state.actors.user.gold).toBe(0);
  });

  it("auto-exits actors via exit_when (lte and gte rules)", () => {
    const dead = applyOps(fresh(), [{ op: "inc", path: "actors.user.hp", value: -10 }]).state;
    expect(dead.game.exited_game).toEqual([{ id: "user", reason: "died" }]);

    const won = applyOps(fresh(), [{ op: "set", path: "actors.user.score", value: 120 }]).state;
    expect(won.game.exited_game).toEqual([{ id: "user", reason: "won" }]);
  });

  it("does not exit an actor twice and clears current_actor on auto-exit", () => {
    const start = fresh();
    start.game.current_actor = "user";
    const once = applyOps(start, [{ op: "inc", path: "actors.user.hp", value: -10 }]).state;
    expect(once.game.current_actor).toBeNull();
    const twice = applyOps(once, [{ op: "inc", path: "actors.user.hp", value: -1 }]).state;
    expect(twice.game.exited_game).toHaveLength(1);
  });

  it("keeps clamping the numbers of someone who is already out (limits apply to everyone)", () => {
    const once = applyOps(fresh(), [{ op: "inc", path: "actors.user.hp", value: -10 }]).state;
    const after = applyOps(once, [{ op: "inc", path: "actors.user.hp", value: 50 }]).state;
    expect(after.actors.user.hp).toBe(10);
    expect(after.game.exited_game).toHaveLength(1);
  });

  it("ignores non-numeric fields in limits/exit_when", () => {
    const { state } = applyOps(fresh(), [{ op: "set", path: "actors.user.hp", value: "lots" }]);
    expect(state.actors.user.hp).toBe("lots");
    expect(state.game.exited_game).toEqual([]);
  });

  it("caps events and per-actor history", () => {
    const ops = [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ op: "push", path: "game.events", value: `e${n}` })),
      ...[1, 2, 3, 4, 5].map((n) => ({ op: "push", path: "actors.user.history", value: `h${n}` })),
    ];
    const { state } = applyOps(fresh(), ops);
    expect(state.game.events).toEqual(["e3", "e4", "e5", "e6"]); // events_limit 4
    expect(state.actors.user.history).toEqual(["h3", "h4", "h5"]); // history_limit 3
  });
});

describe("judgeView", () => {
  it("keeps story fields, drops stats and gear, and trims history/events", () => {
    const s = fresh();
    s.actors.user = { ...s.actors.user, description: "A fighter", inventory: ["sword"], gold: 5,
      history: ["a", "b", "c"], statuses: ["tired"] };
    s.actors.npc_0 = { name: "Eve", controlled_by: "npc", relationship: "friend", statuses: [], history: [], description: "" };
    s.game.events = ["1", "2", "3", "4"];
    const v = judgeView(s);
    expect(v.actors.user).toEqual({ name: "you", controlled_by: "user", description: "A fighter", statuses: ["tired"], history: ["b", "c"] });
    expect(v.actors.npc_0).toEqual({ name: "Eve", controlled_by: "npc", relationship: "friend" });
    expect(v.recent_events).toEqual(["2", "3", "4"]); // judge_events 3
    expect(JSON.stringify(v)).not.toContain("sword");
  });

  it("marks actors who left the game and omits empty events", () => {
    const s = fresh();
    s.game.exited_game = [{ id: "user", reason: "died" }];
    const v = judgeView(s);
    expect(v.actors.user.left_game).toBe("died");
    expect(v.recent_events).toBeUndefined();
  });

  it("falls back to true when the exit reason is empty", () => {
    const s = fresh();
    s.game.exited_game = [{ id: "user", reason: "" }];
    expect(judgeView(s).actors.user.left_game).toBe(true);
  });

  it("skips non-object actors", () => {
    const s = fresh();
    (s.actors as Record<string, unknown>).weird = null;
    expect(judgeView(s).actors.weird).toBeUndefined();
  });
});

describe("prompt blocks", () => {
  it("stateBlock shows state without the rules block, plus active rules", () => {
    const text = stateBlock(fresh());
    expect(text).toContain("CURRENT GAME STATE");
    expect(text).toContain('"location": "start"');
    expect(text).not.toContain('"lift_votes"');
    expect(text).toContain("SESSION RULES IN EFFECT");
    expect(text).toContain("- Proceeds go to charity.");
    expect(text).toContain("controlled_by");
  });

  it("stateBlock announces freshly lifted rules once and hides them from the active list", () => {
    const s = fresh();
    Object.assign(s.game.rules.fog, { active: false, announced: false, lifted_reason: "a boat arrived" });
    const text = stateBlock(s);
    expect(text).toContain("RULES JUST LIFTED");
    expect(text).toContain("Why it ended: a boat arrived");
    expect(text).not.toContain("- Fog traps everyone.\n- ");
    s.game.rules.fog.announced = true;
    expect(stateBlock(s)).not.toContain("RULES JUST LIFTED");
  });

  it("stateBlock omits the rules sections when there are none", () => {
    const s = fresh();
    s.game.rules = {};
    const text = stateBlock(s);
    expect(text).not.toContain("SESSION RULES");
    expect(text).not.toContain("JUST LIFTED");
  });

  it("diceBlock lists every die with the right number of values in range", () => {
    const text = diceBlock();
    const counts: Record<string, [number, number]> = { d20: [8, 20], d12: [3, 12], d10: [3, 10], d8: [4, 8], d6: [8, 6], d4: [4, 4], d100: [2, 100] };
    for (const [die, [n, max]] of Object.entries(counts)) {
      const m = text.match(new RegExp(`^${die}: \\[([^\\]]*)\\]`, "m"));
      expect(m).not.toBeNull();
      const vals = m![1].split(", ").map(Number);
      expect(vals).toHaveLength(n);
      for (const v of vals) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(max); }
    }
  });
});
