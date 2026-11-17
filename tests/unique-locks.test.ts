import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/unique-locks"); // unique_fields, decrease_locks

const { initialState, applyOps, stateNotes, stateBlock } = await import("../src/utils/state.js");
const { fieldRules } = await import("../src/utils/upstream.js");

beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); });

const run = (ops: unknown[], start = initialState()) => applyOps(start, ops);

describe("unique_fields", () => {
  it("ignores a repeated push (case and spacing do not matter) and keeps the first entry", () => {
    const a = run([{ op: "push", path: "actors.user.tags", value: "Opt in: glow gak" }]).state;
    const b = run([{ op: "push", path: "actors.user.tags", value: "  opt IN:   glow gak " }, { op: "push", path: "actors.user.tags", value: "other" }], a);
    expect(b.state.actors.user.tags).toEqual(["Opt in: glow gak", "other"]);
    expect(b.applied).toBe(2);
    expect(b.skipped).toEqual([]);
  });

  it("remove takes out the entry whatever its case, then it can be pushed again (sequence: add, remove, add)", () => {
    let s = run([{ op: "push", path: "actors.user.tags", value: "Opt in" }]).state;
    s = run([{ op: "remove", path: "actors.user.tags", value: "opt in" }], s).state;
    expect(s.actors.user.tags).toEqual([]);
    s = run([{ op: "push", path: "actors.user.tags", value: "opt in" }], s).state;
    expect(s.actors.user.tags).toEqual(["opt in"]);
    s = run([{ op: "remove", path: "actors.user.tags", value: "OPT IN" }, { op: "push", path: "actors.user.tags", value: "opt in" }], s).state;
    expect(s.actors.user.tags).toEqual(["opt in"]); // within one answer the order decides: removed, then added
  });

  it("collapses repeats that were already there (an old save) to the first, and leaves other lists alone", () => {
    const s = initialState();
    s.actors.user.tags = ["a", "A", "b", "a"];
    s.actors.user.statuses = ["x", "x"];
    const out = run([], s).state;
    expect(out.actors.user.tags).toEqual(["a", "b"]);
    expect(out.actors.user.statuses).toEqual(["x", "x"]);
  });

  it("compares non-strings by value", () => {
    const s = run([{ op: "push", path: "actors.user.tags", value: 1 }, { op: "push", path: "actors.user.tags", value: 1 }, { op: "push", path: "actors.user.tags", value: "1" }]).state;
    expect(s.actors.user.tags).toEqual([1, "1"]);
  });
});

describe("decrease_locks", () => {
  it("keeps a field from going down while the other was above the line when the turn began", () => {
    const r = run([{ op: "inc", path: "actors.user.stain", value: -3 }]);
    expect(r.state.actors.user.stain).toBe(4);
  });

  it("lets it rise, and lets other fields move", () => {
    const r = run([{ op: "inc", path: "actors.user.stain", value: 2 }, { op: "inc", path: "actors.user.glow", value: -1 }]);
    expect(r.state.actors.user.stain).toBe(6);
    expect(r.state.actors.user.glow).toBe(1);
  });

  it("judges the order on the turn's start: clearing the coating and cleaning in one reply is not enough, the next turn is", () => {
    const first = run([{ op: "set", path: "actors.user.glow", value: 0 }, { op: "inc", path: "actors.user.stain", value: -3 }]);
    expect(first.state.actors.user.glow).toBe(0);
    expect(first.state.actors.user.stain).toBe(4);
    const second = run([{ op: "inc", path: "actors.user.stain", value: -3 }], first.state);
    expect(second.state.actors.user.stain).toBe(1);
  });

  it("does nothing when the line is not crossed, or for someone new this turn", () => {
    const s = initialState(); s.actors.user.glow = 0;
    expect(run([{ op: "inc", path: "actors.user.stain", value: -2 }], s).state.actors.user.stain).toBe(2);
    const added = run([{ op: "add_actor", id: "npc_1", value: { name: "Bea", stain: 5, glow: 1 } }, { op: "inc", path: "actors.npc_1.stain", value: -2 }]);
    expect(added.state.actors.npc_1.stain).toBe(3); // no record at the turn's start, so no lock
  });

  it("a lock with no `while` keeps the field from ever going down, but lets it rise", () => {
    const down = run([{ op: "set", path: "actors.user.day", value: 2 }]);
    expect(down.state.actors.user.day).toBe(5);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("day of user cannot go down (days only move forward): kept at 5"));
    expect(run([{ op: "inc", path: "actors.user.day", value: 3 }]).state.actors.user.day).toBe(8);
  });

  it("applies to everyone, and warns", () => {
    const s = initialState();
    s.actors.npc_1 = { name: "Bea", stain: 6, glow: 3, tags: [], history: [], statuses: [] } as any;
    const r = run([{ op: "inc", path: "actors.npc_1.stain", value: -4 }], s);
    expect(r.state.actors.npc_1.stain).toBe(6);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("stain of npc_1 cannot go down while glow is 3 (the glow coats the stain)"));
  });

  it("remembers the refusal for one turn so the narrator is told, then forgets it", () => {
    const start = initialState();
    const r = run([{ op: "inc", path: "actors.user.stain", value: -3 }], start);
    expect(r.state.game.blocked).toEqual([expect.stringContaining("Joey's stain could not go down (the glow coats the stain): it stays at 4.")]);
    expect(stateNotes(start, r.state)).toContain("a change the server did not allow");
    expect(run([{ op: "inc", path: "actors.user.stain", value: 1 }], r.state).state.game.blocked).toBeUndefined();
  });

  it("the model cannot write the refusal list itself", () => {
    const r = run([{ op: "set", path: "game.blocked", value: ["x"] }]);
    expect(r.skipped.join()).toContain("server-owned");
  });
});

describe("allowed_values", () => {
  it("accepts a listed value in any case and stores it as listed", () => {
    const r = run([{ op: "set", path: "game.ambient", value: "HOT" }]);
    expect(r.state.game.ambient).toBe("hot");
    expect(r.skipped).toEqual([]);
  });

  it("rejects a value that is not listed, for a game field and for an actor field, and leaves the old one", () => {
    const r = run([{ op: "set", path: "game.ambient", value: "scorching" }, { op: "set", path: "actors.user.mood", value: "furious" }, { op: "set", path: "actors.user.mood", value: "Angry" }]);
    expect(r.state.game.ambient).toBe("mild");
    expect(r.state.actors.user.mood).toBe("angry");
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]).toContain('game.ambient must be one of "cold", "mild", "hot"');
  });

  it("checks the fields of a new actor, and leaves other fields free", () => {
    const bad = run([{ op: "add_actor", id: "npc_1", value: { name: "Bea", mood: "sleepy" } }]);
    expect(bad.state.actors.npc_1).toBeUndefined();
    const ok = run([{ op: "add_actor", id: "npc_1", value: { name: "Bea", mood: "ANGRY" } }, { op: "set", path: "game.phase", value: "anything" }]);
    expect(ok.state.actors.npc_1.mood).toBe("angry");
    expect(ok.state.game.phase).toBe("anything");
  });

  it("applies to pushes into a list field too", () => {
    const s = initialState(); s.actors.user.mood = [] as any;
    const r = run([{ op: "push", path: "actors.user.mood", value: "bored" }, { op: "push", path: "actors.user.mood", value: "calm" }], s);
    expect(r.state.actors.user.mood).toEqual(["calm"]);
  });
});

describe("sticky_fields", () => {
  const sky = (v: unknown) => [{ op: "set", path: "game.sky", value: v }];

  it("changes only when the same new value is set on two turns in a row", () => {
    const one = run(sky("overcast"));
    expect(one.state.game.sky).toBe("clear");
    expect(one.state.game.pending).toEqual({ "game.sky": { value: "overcast", count: 1 } });
    const two = run(sky("OVERCAST"), one.state);
    expect(two.state.game.sky).toBe("overcast");
    expect(two.state.game.pending).toBeUndefined();
    expect(two.applied).toBe(1);
  });

  it("applies the server's own writes at once (a hazard moves the shelter's ambient even right after it was set)", async () => {
    const { applyServerOps } = await import("../src/utils/state.js");
    const r = applyServerOps(initialState(), sky("overcast"));
    expect(r.state.game.sky).toBe("overcast");
    expect(r.state.game.pending).toBeUndefined();
    expect(r.skipped).toEqual([]);
  });

  it("takes the first value of an empty field at once, then makes changes wait", () => {
    const first = run([{ op: "set", path: "game.zone", value: "north" }]);
    expect(first.state.game.zone).toBe("north");
    expect(first.state.game.pending).toBeUndefined();
    const again = run([{ op: "set", path: "game.zone", value: "south" }], first.state);
    expect(again.state.game.zone).toBe("north");
  });

  it("drops a proposal that is not repeated the very next turn, and restarts the count on a different value", () => {
    const one = run(sky("overcast")).state;
    const gap = run([], one).state;
    expect(gap.game.pending).toBeUndefined();
    expect(run(sky("overcast"), gap).state.game.sky).toBe("clear");
    const other = run(sky("storm"), one).state;
    expect(other.game.sky).toBe("clear");
    expect(other.game.pending).toEqual({ "game.sky": { value: "storm", count: 1 } });
  });

  it("setting what is already there does nothing and clears a proposal", () => {
    const one = run(sky("overcast")).state;
    const back = run(sky("clear"), one).state;
    expect(back.game.sky).toBe("clear");
    expect(back.game.pending).toBeUndefined();
  });

  it("still rejects an invalid value outright, without leaving a proposal", () => {
    const r = run(sky("blizzard-of-doom"));
    expect(r.skipped[0]).toContain("game.sky must be one of");
    expect(r.state.game.pending).toBeUndefined();
  });

  it("keeps the pending list from the narrator, and the model cannot write it", () => {
    const one = run(sky("overcast")).state;
    expect(stateBlock(one)).not.toContain("pending");
    expect(run([{ op: "set", path: "game.pending", value: {} }], one).skipped.join()).toContain("server-owned");
  });
});

describe("fieldRules (what the extractor is told)", () => {
  it("lists the allowed values and the fields that must be repeated", () => {
    const t = fieldRules();
    expect(t).toContain('- game.ambient: "cold", "mild", "hot"');
    expect(t).toContain("- mood: \"calm\", \"angry\"");
    expect(t).toContain("- game.sky: 2 turns in a row");
  });
});
