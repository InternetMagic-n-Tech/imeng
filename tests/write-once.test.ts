import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/once");
const { initialState, applyOps } = await import("../src/utils/state.js");

describe("write_once", () => {
  it("the first set goes through and locks the field; a later change is refused", () => {
    const a = applyOps(initialState(), [{ op: "set", path: "actors.user.relationship", value: "dating" }]);
    expect(a.state.actors.user.relationship).toBe("dating");
    const b = applyOps(a.state, [{ op: "set", path: "actors.user.relationship", value: "single" }]);
    expect(b.state.actors.user.relationship).toBe("dating");
    expect(b.guarded?.[0]).toMatch(/cannot change once set/);
    const c = applyOps(a.state, [{ op: "set", path: "actors.npc_bo.relationship", value: "married" }]); // another actor has its own lock
    expect(c.state.actors.npc_bo.relationship).toBe("married");
  });
});
