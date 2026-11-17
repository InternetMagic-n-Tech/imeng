import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/tone");
const { initialState, applyOps, stateBlock, toneBlock } = await import("../src/utils/state.js");

describe("character tone and roles", () => {
  it("shows tone fields as the character's voice, and does not mask them even when pii lists them", () => {
    const st = initialState();
    const block = toneBlock(st);
    expect(block).toContain("CHARACTER VOICE");
    expect(block).toContain("loud, sailor-mouthed grandma");
    expect(block).toContain("sequin tracksuit");
    const shown = stateBlock(st);
    expect(shown).toContain("sailor-mouthed grandma"); // pii listed description, but tone fields win
    expect(shown).not.toContain("71"); // the age is still masked
  });
  it("refuses a field change for an actor whose role is not allowed (the Host is never gak'd)", () => {
    const st = initialState();
    const r = applyOps(st, [{ op: "inc", path: "actors.npc_bo.score", value: 1 }, { op: "inc", path: "actors.user.score", value: 1 }]);
    expect(r.state.actors.npc_bo.score).toBe(0);
    expect(r.state.actors.user.score).toBe(1);
    expect(r.guarded?.[0]).toMatch(/cannot change for role host/);
  });
});

