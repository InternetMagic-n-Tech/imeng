import { describe, it, expect, beforeAll } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/alias"); // alias_fields: ["address_as"]
let applyOps: typeof import("../src/utils/state.js").applyOps;
let initialState: typeof import("../src/utils/state.js").initialState;
beforeAll(async () => ({ applyOps, initialState } = await import("../src/utils/state.js")));

const names = (s: { actors: Record<string, { name?: unknown }> }) => Object.values(s.actors).map((a) => a.name);

describe("alias_fields", () => {
  it("drops an actor added under another actor's alias, whichever op comes first", () => {
    const a = applyOps(initialState(), [
      { op: "add_actor", id: "npc_9", value: { name: "Dr. Okafor" } },
      { op: "set", path: "actors.npc_0.address_as", value: "Dr. Okafor" },
    ]).state;
    expect(names(a)).toEqual(["Joey", "Marta"]);
    expect(a.actors.npc_0.address_as).toBe("Dr. Okafor");

    const b = applyOps(initialState(), [
      { op: "set", path: "actors.npc_0.address_as", value: "dr. okafor" },
      { op: "add_actor", id: "npc_9", value: { name: " Dr. Okafor " } },
    ]).state;
    expect(names(b)).toEqual(["Joey", "Marta"]);
  });

  it("still adds real new people, and keeps actors from earlier turns", () => {
    const s = applyOps(initialState(), [{ op: "add_actor", id: "npc_1", value: { name: "Dot" } }]).state;
    expect(names(s)).toEqual(["Joey", "Marta", "Dot"]);
    const t = applyOps(s, [{ op: "set", path: "actors.npc_1.address_as", value: "Dot" }]).state; // an alias equal to its own name
    expect(names(t)).toEqual(["Joey", "Marta", "Dot"]);
  });
});
