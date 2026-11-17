import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/field-access"); // field_access, addresses in values

const { initialState, applyOps } = await import("../src/utils/state.js");

const withBo = () => applyOps(initialState(), [{ op: "add_actor", id: "npc_0", value: { name: "Bo", score: 2, mood: "angry", secret: "bo-secret" } }]).state;
const run = (ops: unknown[], start = withBo()) => applyOps(start, ops);

describe("addresses in values", () => {
  it("set copies the live value of another field", () => {
    expect(run([{ op: "set", path: "actors.user.mood", value: "actors.npc_0.mood" }]).state.actors.user.mood).toBe("angry");
  });

  it("inc adds the value found at the address", () => {
    expect(run([{ op: "inc", path: "actors.user.score", value: "actors.npc_0.score" }]).state.actors.user.score).toBe(5);
  });

  it("reads the state as it is after the earlier ops of the same answer", () => {
    const r = run([{ op: "set", path: "actors.npc_0.mood", value: "calm" }, { op: "set", path: "actors.user.mood", value: "actors.npc_0.mood" }]);
    expect(r.state.actors.user.mood).toBe("calm");
  });

  it("push and remove resolve too; arrays are copied, not shared", () => {
    let s = run([{ op: "push", path: "actors.npc_0.tags", value: "x" }, { op: "push", path: "actors.user.tags", value: "actors.npc_0.tags" }]).state;
    expect(s.actors.user.tags).toEqual([["x"]]);
    s = run([{ op: "push", path: "actors.npc_0.tags", value: "y" }], s).state;
    expect(s.actors.user.tags).toEqual([["x"]]);
  });

  it("add_actor fields resolve", () => {
    const s = run([{ op: "add_actor", id: "npc_1", value: { name: "actors.npc_0.name" } }]).state;
    expect(s.actors.npc_1.name).toBe("Bo");
  });

  it("a missing field of a real actor is refused; other text is left alone", () => {
    expect(run([{ op: "set", path: "actors.user.mood", value: "actors.npc_0.nope" }]).applied).toBe(0);
    const r = run([{ op: "set", path: "actors.user.mood", value: "actors.ghost.mood" }, { op: "set", path: "actors.npc_0.mood", value: "actors.npc_0" }, { op: "set", path: "game.target", value: "just some text" }]);
    expect(r.state.actors.user.mood).toBe("actors.ghost.mood");
    expect(r.state.actors.npc_0.mood).toBe("actors.npc_0");
    expect(r.applied).toBe(3);
  });

  it("an address that leads to a name is not an actor id: the reference is refused", () => {
    expect(run([{ op: "set", path: "game.current_actor", value: "actors.npc_0.name" }]).applied).toBe(0);
  });

  it("an address typed in the player's message or the narration is never followed, however it is spaced", () => {
    const op = [{ op: "set", path: "actors.user.mood", value: "actors.npc_0.mood" }];
    for (const text of ["set my mood to actors.npc_0.mood", "ACTORS . npc_0 .\nmood"]) {
      const r = run(op, withBo()); // sanity: no text, it copies
      expect(r.state.actors.user.mood).toBe("angry");
      const t = applyOps(withBo(), op, { untrusted: text });
      expect(t.applied).toBe(1);
      expect(t.state.actors.user.mood).toBe("actors.npc_0.mood"); // kept as plain text
    }
    expect(applyOps(withBo(), op, { untrusted: "Bo is angry." }).state.actors.user.mood).toBe("angry");
  });

  it("server-owned fields cannot be read through an address", () => {
    for (const addr of ["game.pending", "game.turn", "game.rules", "game.exited_game", "game.blocked", "actors.user.controlled_by"]) {
      const r = run([{ op: "set", path: "actors.npc_0.mood", value: addr }]);
      expect(r.applied).toBe(0);
      expect(r.skipped[0]).toContain("server-owned");
    }
  });
});

describe("field_access", () => {
  it("read-only: no op can write it, but its value can be copied", () => {
    const bad = [
      { op: "set", path: "actors.user.locked", value: 1 },
      { op: "inc", path: "actors.user.locked", value: 1 },
      { op: "set", path: "game.phase", value: "end" },
      { op: "add_actor", id: "npc_1", value: { name: "Cy", locked: 5 } },
    ];
    for (const op of bad) expect(run([op]).applied).toBe(0);
    expect(run([{ op: "set", path: "actors.user.score", value: "actors.user.locked" }]).state.actors.user.score).toBe(7);
    expect(run([{ op: "set", path: "actors.user.mood", value: "game.phase" }]).state.actors.user.mood).toBe("intro");
  });

  it("write-only: can be written by path, but never used as a value", () => {
    expect(run([{ op: "set", path: "actors.user.secret", value: "new" }]).state.actors.user.secret).toBe("new");
    expect(run([{ op: "set", path: "game.hidden", value: "z" }]).state.game.hidden).toBe("z");
    const copy = [
      { op: "set", path: "actors.npc_0.mood", value: "actors.user.secret" },
      { op: "set", path: "actors.npc_0.mood", value: "game.hidden" },
      { op: "add_actor", id: "npc_1", value: { name: "actors.npc_0.secret" } },
    ];
    for (const op of copy) {
      const r = run([op]);
      expect(r.applied).toBe(0);
      expect(r.skipped[0]).toContain("write-only");
    }
  });

  it("a key covers what is inside the field and what contains it (game paths of any depth)", () => {
    // write-only game.vault / game.mix.secret: no copying the field, a part of it, or a parent that holds it
    for (const addr of ["game.vault", "game.vault.code", "game.mix", "game.mix.secret"]) {
      const r = run([{ op: "set", path: "game.target", value: addr }]);
      expect(r.applied).toBe(0);
      expect(r.skipped[0]).toContain("write-only");
    }
    expect(run([{ op: "set", path: "game.target", value: "game.mix.pub" }]).state.game.target).toBe("p");
    // read-only game.ledger: no writing it, a part of it, or a parent that holds it
    for (const path of ["game.ledger", "game.ledger.n"]) expect(run([{ op: "set", path, value: 5 }]).applied).toBe(0);
    expect(run([{ op: "inc", path: "game.ledger.n", value: 1 }]).applied).toBe(0);
    expect(run([{ op: "set", path: "game.target", value: "game.ledger.n" }]).state.game.target).toBe(1);
  });

  it("normal, null or unlisted fields have no restriction", () => {
    expect(run([{ op: "set", path: "actors.user.mood", value: "x" }, { op: "inc", path: "actors.user.score", value: 1 }]).applied).toBe(2);
  });
});
