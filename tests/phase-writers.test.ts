import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/writers");
const { applyOps, initialState } = await import("../src/utils/state.js");

describe("phase writers", () => {
  const fresh = (): any => { const s: any = initialState(); s.actors.npc1 = { name: "Zed", score: 0, controlled_by: "npc", statuses: [], history: [] }; return s; };
  it("a value only the listed controllers may change is put back for anyone else, and the narrator is told", () => {
    const r = applyOps(fresh(), [{ op: "set", path: "actors.npc1.score", value: 5 }, { op: "set", path: "actors.user.score", value: 2 }]);
    expect((r.state.actors.npc1 as any).score).toBe(0);
    expect((r.state.actors.user as any).score).toBe(2);
    expect(JSON.stringify(r.state.game.blocked)).toContain("Zed's score cannot be changed in this phase");
  });
  it("a game path without narrator in its list is the producer's and the server's only", () => {
    const r = applyOps(fresh(), [{ op: "set", path: "game.place", value: "the roof" }]);
    expect((r.state.game as any).place).not.toBe("the roof");
    expect(JSON.stringify(r.state.game.blocked)).toContain("game.place cannot be changed by the narrator");
  });
});
