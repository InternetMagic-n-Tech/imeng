import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/hazard");
const { rollHazards, callShelter, _resetHazards } = await import("../src/utils/random-events.js");
const { initialState } = await import("../src/utils/state.js");
const mk = (g: Record<string, unknown> = {}) => { const s: any = initialState(); Object.assign(s.game, g); return s; };

describe("hazards", () => {
  it("rolls with season and producer modifier, moves to the shelter, once", async () => {
    const sess: any = { snapshots: [] };
    const r = await rollHazards(sess, mk(), 3, () => 0.25); // base 0.1 x winter 3 = 0.3
    expect((r.game as any).hazard_done).toBe("blizzard");
    expect((r.game as any).place).toBe("the bunker sauna");
    expect(sess.pendingEvents[0].text).toContain("blizzard");
    expect(((await rollHazards(sess, r, 4, () => 0.02)).game as any).hazard_count).toBe(2); // 0.3 x 0.1 = 0.03
    expect((await rollHazards(sess, r, 4, () => 0.5)).game).toHaveProperty("hazard_count", 1); // far less likely
  });
  it("season changes the odds, and the producer's modifier scales them", async () => {
    const s: any = { snapshots: [] };
    expect((await rollHazards(s, mk({ season: "summer" }), 1, () => 0)).game).not.toHaveProperty("hazard_done"); // summer x0
    expect((await rollHazards(s, mk({ hazard_mod: 0 }), 1, () => 0)).game).not.toHaveProperty("hazard_done");
    expect(((await rollHazards(s, mk({ hazard_mod: 2 }), 1, () => 0.55)).game as any).hazard_done).toBe("blizzard"); // 0.6
  });
  it("a function in the imeng can replace the chance (the north pole)", async () => {
    _resetHazards();
    const s: any = { snapshots: [] };
    const r = await rollHazards(s, mk({ lat: 89, hazard_mod: 0 }), 1, () => 0.8);
    expect((r.game as any).hazard_done).toBe("blizzard");
  });
  it("the producer can call the shelter at once", () => {
    const s: any = { snapshots: [] };
    const r = callShelter(s, mk(), 2)!;
    expect((r.game as any).place).toBe("the bunker sauna");
    expect(callShelter(s, r, 3)).not.toBeNull();
  });
});

describe("protected server fields", () => {
  it("the shelter and hazard counters are written by the server's own operations", async () => {
    const s: any = { snapshots: [] };
    const r = callShelter(s, mk(), 2)!;
    expect(r.game).toHaveProperty("hazard_count", 1);
    expect((r.game as any).shelter).toBe("in"); // a server-owned field set by the hazard itself
  });
});
