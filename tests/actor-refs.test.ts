import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/actor-refs"); // actor_ref_fields

const { initialState, applyOps } = await import("../src/utils/state.js");
const { resolveRefs } = await import("../src/utils/refs.js");
const { REFS } = await import("../src/utils/config.js");

beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "log").mockImplementation(() => {}); });

const withMarta = () => applyOps(initialState(), [{ op: "add_actor", id: "npc_0", value: { name: "Marta Okafor" } }]).state;
const set = (path: string, value: unknown, start = withMarta()) => applyOps(start, [{ op: "set", path, value }]);
const judgeSays = (payload: unknown) => mockFetch(() => jsonResponse({ message: { content: JSON.stringify(payload) } }));

describe("actor_ref_fields: applyOps takes ids only", () => {
  it("accepts the id, actors.<id> or the id in another case, and stores the id", () => {
    for (const v of ["npc_0", "actors.npc_0", "NPC_0"]) {
      const r = set("game.target", v);
      expect(r.applied).toBe(1);
      expect(r.state.game.target).toBe("npc_0");
    }
  });

  it("refuses a name, anything that is not an actor, and prototype keys; null clears", () => {
    expect(set("game.target", "Marta Okafor").applied).toBe(0);
    expect(set("game.targeter", "actors.ghost").applied).toBe(0);
    expect(set("game.targeter", "constructor").applied).toBe(0);
    expect(set("game.targeter", 5).applied).toBe(0);
    const s = set("game.targeter", "user").state;
    expect(set("game.targeter", null, s).state.game.targeter).toBeNull();
  });

  it("covers actor fields too, and game.current_actor is always a reference", () => {
    expect(set("actors.user.rival", "actors.npc_0").state.actors.user.rival).toBe("npc_0");
    expect(set("actors.user.rival", "nobody").applied).toBe(0);
    expect(set("game.current_actor", "actors.user").state.game.current_actor).toBe("user");
  });

  it("an address to a field that holds an id works as a copy", () => {
    const s = set("game.target", "npc_0").state;
    expect(set("game.current_actor", "game.target", s).state.game.current_actor).toBe("npc_0");
  });

  it("clears every field that names an actor who leaves the game", () => {
    let s = applyOps(withMarta(), [
      { op: "set", path: "game.current_actor", value: "npc_0" },
      { op: "set", path: "game.target", value: "npc_0" },
      { op: "set", path: "game.targeter", value: "user" },
      { op: "set", path: "actors.user.rival", value: "npc_0" },
    ]).state;
    s = applyOps(s, [{ op: "exit_actor", id: "npc_0", reason: "left" }]).state;
    expect(s.game.current_actor).toBeNull();
    expect(s.game.target).toBeNull();
    expect(s.actors.user.rival).toBeNull();
    expect(s.game.targeter).toBe("user");
  });
});

describe("ids of actors", () => {
  it("add_actor refuses ids that cannot be addressed or that shadow built-ins, and a set cannot make a phantom actor", () => {
    for (const id of ["a.b", "x y", " npc", "toString", "constructor", "__proto__", "a/b"]) {
      const r = applyOps(initialState(), [{ op: "add_actor", id, value: { name: "N" } }]);
      expect([id, r.applied, Object.hasOwn(r.state.actors, id)]).toEqual([id, 0, false]);
    }
    expect(applyOps(initialState(), [{ op: "add_actor", id: "a.b", value: { name: "N" } }]).applied).toBe(0);
    expect(applyOps(initialState(), [{ op: "set", path: "actors.a.b.name", value: "x" }]).applied).toBe(0);
    expect(applyOps(initialState(), [{ op: "set", path: "actors.ghost.name", value: "x" }]).applied).toBe(0);
  });

  it("with no mint, an actor without an id gets the name as a slug, and a taken id is refused", () => {
    expect(Object.keys(applyOps(initialState(), [{ op: "add_actor", value: { name: "Dr. Okafor" } }]).state.actors)).toEqual(["user", "dr_okafor"]);
    expect(applyOps(withMarta(), [{ op: "add_actor", id: "npc_0", value: { name: "Again" } }]).skipped[0]).toContain("bad/duplicate actor");
  });
});

describe("resolveRefs: the judge matches names to actors", () => {
  it("replaces a name by the actor the judge numbers, and shows names, not ids", async () => {
    const f = judgeSays({ n: 2 });
    const ops = await resolveRefs(withMarta(), [{ op: "set", path: "game.target", value: "the doctor" }], "Marta is the doctor.") as any[];
    expect(ops[0].value).toBe("npc_0");
    const body = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[1].content).toContain("Marta Okafor");
    expect(body.messages[1].content).not.toContain("npc_0");
  });

  it("leaves ids, actors.<id>, null, addresses, other ops and other fields alone, with no judge call", async () => {
    const f = judgeSays({ n: 1 });
    const input = [
      { op: "set", path: "game.target", value: "npc_0" }, { op: "set", path: "game.target", value: "actors.npc_0" },
      { op: "set", path: "game.target", value: null }, { op: "set", path: "game.target", value: "game.current_actor" },
      { op: "inc", path: "actors.user.score", value: 1 }, { op: "set", path: "actors.user.name", value: "Marta Okafor" },
    ];
    expect(await resolveRefs(withMarta(), input, "")).toEqual(input);
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores an answer that is not a number on the list: the name stays and applyOps rejects it", async () => {
    for (const answer of [{ n: 0 }, { n: 3 }, { n: null }, { n: "2" }, { id: "npc_0" }, {}]) {
      judgeSays(answer);
      const ops = await resolveRefs(withMarta(), [{ op: "set", path: "game.target", value: "Marta" }], "") as any[];
      expect(ops[0].value).toBe("Marta");
      expect(applyOps(withMarta(), ops).applied).toBe(0);
    }
  });

  it("an actor added earlier in the same answer is on the list", async () => {
    const f = judgeSays({ n: 3 });
    const ops = await resolveRefs(withMarta(), [{ op: "add_actor", id: "npc_1", value: { name: "Eve" } }, { op: "set", path: "game.target", value: "Eve" }], "") as any[];
    expect(ops[1].value).toBe("npc_1");
    expect(String((f.mock.calls[0] as [string, RequestInit])[1].body)).toContain("Eve");
    expect(applyOps(withMarta(), ops).state.game.target).toBe("npc_1");
  });

  it("judge unreachable: only an exact, unique name is accepted", async () => {
    mockFetch(() => { throw new TypeError("fetch failed"); });
    const one = await resolveRefs(withMarta(), [{ op: "set", path: "game.target", value: "  marta   OKAFOR " }], "") as any[];
    expect(one[0].value).toBe("npc_0");
    const two = applyOps(withMarta(), [{ op: "add_actor", id: "npc_1", value: { name: "Marta Okafor" } }]).state;
    expect((await resolveRefs(two, [{ op: "set", path: "game.target", value: "Marta Okafor" }], "") as any[])[0].value).toBe("Marta Okafor");
    expect((await resolveRefs(withMarta(), [{ op: "set", path: "game.target", value: "Zed" }], "") as any[])[0].value).toBe("Zed");
  });

  it("calls the judge at most 5 times per answer", async () => {
    const f = judgeSays({ n: null });
    await resolveRefs(withMarta(), Array.from({ length: 9 }, () => ({ op: "set", path: "game.target", value: "Zed" })), "");
    expect(f).toHaveBeenCalledTimes(5);
  });
});

describe("actor_ref_fields in config.json is checked", () => {
  it("drops server-owned, nested and prototype entries", () => {
    expect(REFS.map((r) => r.path).sort()).toEqual(["actors.*.rival", "game.current_actor", "game.target", "game.targeter"]);
  });
});
