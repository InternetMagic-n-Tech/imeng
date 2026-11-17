import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/rand");
const { rollEvents, eventsBlock } = await import("../src/utils/random-events.js");
const { initialState } = await import("../src/utils/state.js");

describe("random events", () => {
  it("fires once when the roll lands, sets state, and tells the narrator on the next round", () => {
    const s: any = { snapshots: [] };
    const r = rollEvents(s, initialState(), 3, () => 0);
    expect(r.fired.map((f) => f.id)).toEqual(["heat"]);
    expect(r.state.game.ambient).toBe("hot");
    expect(eventsBlock(s, 4)).toContain("very hot");
    expect(rollEvents(s, r.state, 4, () => 0).fired).toEqual([]); // once
  });
  it("does nothing when the roll misses", () => {
    expect(rollEvents({ snapshots: [] } as any, initialState(), 3, () => 0.9).fired).toEqual([]);
  });
});
