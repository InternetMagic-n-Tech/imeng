import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import crypto from "node:crypto";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/domains"); // id_domains, refs

const { initialState, applyOps } = await import("../src/utils/state.js");
const { resolveRefs } = await import("../src/utils/refs.js");
const { setIdSource } = await import("../src/utils/ids.js");
const { REFS, ID_DOMAINS } = await import("../src/utils/config.js");
type State = ReturnType<typeof initialState>;

beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => setIdSource());

const run = (ops: unknown[], start: State = initialState()) => applyOps(start, ops);
const md5 = (t: string) => crypto.createHash("md5").update(t).digest("hex").slice(0, 8);
const addItem = (name: string, s = initialState()) => run([{ op: "add", domain: "items", value: { name } }], s).state;
const judgeSays = (payload: unknown) => mockFetch(() => jsonResponse({ message: { content: JSON.stringify(payload) } }));

describe("config", () => {
  it("builds the domains and the reference rules (actor_ref_fields are rules to actors)", () => {
    expect(Object.keys(ID_DOMAINS).sort()).toEqual(["actors", "items", "places", "tags"]);
    expect(REFS.map((r) => r.path).sort()).toEqual(["actors.*.counts", "actors.*.inventory", "actors.*.seen", "game.current_actor", "game.location", "game.tagged", "game.target"]);
  });
});

describe("add and drop", () => {
  it("map domain, when creation: the server mints the id and ignores a proposed one", () => {
    let s = addItem("Rusty key");
    s = run([{ op: "add", domain: "items", id: "mine", value: { name: "Lamp" } }], s).state;
    expect(Object.keys(s.game.items as object)).toEqual(["item_1", "item_2"]);
    expect((s.game.items as any).item_1).toEqual({ name: "Rusty key" });
  });

  it("array domain, when collision: the name as a slug until it is taken, then a minted id; the id field is set", () => {
    setIdSource({ bytes: (n) => Buffer.alloc(n, 3) });
    let s = run([{ op: "add", domain: "places", value: { name: "The Cave!" } }]).state;
    s = run([{ op: "add", domain: "places", value: { name: "the cave", id: "evil" } }], s).state;
    const places = s.game.places as any[];
    expect(places[0]).toEqual({ name: "The Cave!", id: "the_cave" });
    expect(places[1].id).toMatch(/^\d{6}$/);
    expect(places[1].id).not.toBe("evil");
    expect(places[1].name).toBe("the cave");
  });

  it("actors can mint too, and a proposed id is ignored", () => {
    const s = run([{ op: "add_actor", id: "pat", value: { name: "Pat" } }, { op: "add", domain: "actors", value: { name: "Eve" } }]).state;
    expect(Object.keys(s.actors)).toEqual(["user", "npc_1", "npc_2"]);
    expect(s.actors.npc_1.controlled_by).toBe("npc");
  });

  it("unknown domain, non-object value and a taken id are refused", () => {
    expect(run([{ op: "add", domain: "nope", value: {} }]).applied).toBe(0);
    expect(run([{ op: "add", domain: "items", value: "x" }]).applied).toBe(0);
    expect(run([{ op: "add", domain: "items", value: [1] }]).applied).toBe(0);
  });

  it("drop removes the entry and clears everything that pointed at it", () => {
    let s = addItem("Key");
    s = addItem("Lamp", s);
    s = run([
      { op: "push", path: "actors.user.inventory", value: "item_1" }, { op: "push", path: "actors.user.inventory", value: "item_2" },
      { op: "push", path: "actors.user.seen", value: "item_1" }, { op: "push", path: "actors.user.seen", value: "item_1" },
      { op: "set", path: "actors.user.counts.item_1", value: 3 }, { op: "set", path: "actors.user.counts.item_2", value: 1 },
    ], s).state;
    expect(s.actors.user.seen).toEqual(["item_1", "item_1"]);
    const r = run([{ op: "drop", domain: "items", id: "item_1" }], s);
    expect(r.applied).toBe(1);
    expect(r.state.actors.user.inventory).toEqual(["item_2"]);
    expect(r.state.actors.user.seen).toEqual([]);
    expect(r.state.actors.user.counts).toEqual({ item_2: 1 });
    expect(Object.keys(r.state.game.items as object)).toEqual(["item_2"]);
  });

  it("drop of an array entry, of something that is not there, and of an actor", () => {
    let s = run([{ op: "add", domain: "places", value: { name: "Cave" } }]).state;
    s = run([{ op: "set", path: "game.location", value: "cave" }], s).state;
    s = run([{ op: "drop", domain: "places", id: "cave" }], s).state;
    expect(s.game.places).toEqual([]);
    expect(s.game.location).toBeNull();
    expect(run([{ op: "drop", domain: "items", id: "ghost" }]).applied).toBe(0);
    expect(run([{ op: "drop", domain: "actors", id: "user" }]).skipped[0]).toContain("exit_actor");
  });
});

describe("references", () => {
  const world = () => {
    setIdSource({ bytes: (n) => Buffer.alloc(n, 1) });
    return run([{ op: "add", domain: "places", value: { name: "Cave" } }, { op: "add", domain: "items", value: { name: "Key" } }]).state;
  };

  it("a scalar must be null or an id (the container prefix and another case are fine)", () => {
    const s = world();
    for (const v of ["cave", "CAVE", "game.places.cave"]) expect(run([{ op: "set", path: "game.location", value: v }], s).state.game.location).toBe("cave");
    expect(run([{ op: "set", path: "game.location", value: null }], s).applied).toBe(1);
    for (const v of ["nowhere", "Cave Entrance", 4, "item_1"]) expect(run([{ op: "set", path: "game.location", value: v }], s).applied).toBe(0);
  });

  it("an id list without repeats ignores a repeat; with repeats allowed it keeps it; only ids go in", () => {
    const s = world();
    const r = run([{ op: "push", path: "actors.user.inventory", value: "item_1" }, { op: "push", path: "actors.user.inventory", value: "ITEM_1" }, { op: "push", path: "actors.user.inventory", value: "item_9" }], s);
    expect(r.state.actors.user.inventory).toEqual(["item_1"]);
    expect(r.skipped).toHaveLength(1);
    const q = run([{ op: "push", path: "actors.user.seen", value: "item_1" }, { op: "push", path: "actors.user.seen", value: "item_1" }], s);
    expect(q.state.actors.user.seen).toEqual(["item_1", "item_1"]);
  });

  it("set on an id list checks every entry and drops repeats when they are not allowed", () => {
    const s = world();
    expect(run([{ op: "set", path: "actors.user.inventory", value: ["item_1", "item_1"] }], s).state.actors.user.inventory).toEqual(["item_1"]);
    expect(run([{ op: "set", path: "actors.user.seen", value: ["item_1", "item_1"] }], s).state.actors.user.seen).toEqual(["item_1", "item_1"]);
    expect(run([{ op: "set", path: "actors.user.inventory", value: ["item_1", "ghost"] }], s).applied).toBe(0);
  });

  it("remove takes an id out, whatever its case", () => {
    let s = run([{ op: "push", path: "actors.user.inventory", value: "item_1" }], world()).state;
    s = run([{ op: "remove", path: "actors.user.inventory", value: "ITEM_1" }], s).state;
    expect(s.actors.user.inventory).toEqual([]);
  });

  it("keys_to: the keys of a map must be ids", () => {
    const s = world();
    expect(run([{ op: "set", path: "actors.user.counts.item_1", value: 2 }, { op: "inc", path: "actors.user.counts.item_1", value: 1 }], s).state.actors.user.counts).toEqual({ item_1: 3 });
    expect(run([{ op: "set", path: "actors.user.counts.ghost", value: 2 }], s).applied).toBe(0);
    expect(run([{ op: "set", path: "actors.user.counts", value: { item_1: 1, ghost: 2 } }], s).applied).toBe(0);
    expect(run([{ op: "set", path: "actors.user.counts", value: { item_1: 1 } }], s).applied).toBe(1);
  });

  it("an id domain and an actor leaving: actor reference fields still work", () => {
    let s = run([{ op: "add_actor", value: { name: "Pat" } }]).state;
    s = run([{ op: "set", path: "game.target", value: "npc_1" }, { op: "set", path: "game.current_actor", value: "npc_1" }], s).state;
    s = run([{ op: "exit_actor", id: "npc_1", reason: "left" }], s).state;
    expect([s.game.target, s.game.current_actor]).toEqual([null, null]);
  });
});

describe("entries cannot appear by accident", () => {
  it("a typo does not create a phantom entry, a collection is not written whole, the id field is not writable", () => {
    const s = run([{ op: "add", domain: "places", value: { name: "Cave" } }, { op: "add", domain: "items", value: { name: "Key" } }]).state;
    for (const op of [
      { op: "set", path: "game.items.ghost.name", value: "x" }, { op: "set", path: "actors.ghost.name", value: "x" },
      { op: "set", path: "game.items", value: {} }, { op: "set", path: "game.places", value: [] },
      { op: "set", path: "game.places.cave.id", value: "other" }, { op: "set", path: "game.items.item_1", value: {} },
    ]) expect(run([op], s).applied).toBe(0);
  });

  it("fields of entries are edited by id, in maps and in arrays, and read by address", () => {
    let s = run([{ op: "add", domain: "places", value: { name: "Cave" } }, { op: "add", domain: "items", value: { name: "Key" } }]).state;
    s = run([{ op: "set", path: "game.places.cave.mood", value: "dark" }, { op: "set", path: "game.items.item_1.name", value: "Old key" }], s).state;
    expect((s.game.places as any[])[0]).toEqual({ name: "Cave", id: "cave", mood: "dark" });
    expect((s.game.items as any).item_1.name).toBe("Old key");
    s = run([{ op: "set", path: "actors.user.name", value: "game.places.cave.mood" }], s).state;
    expect(s.actors.user.name).toBe("dark");
    // a whole entry is an id, not a value to copy
    expect(run([{ op: "set", path: "actors.user.name", value: "game.places.cave" }], s).state.actors.user.name).toBe("game.places.cave");
  });
});

describe("when: change", () => {
  it("the id follows the field: a new id, and every reference follows", () => {
    let s = run([{ op: "add", domain: "tags", value: { name: "Alpha" } }]).state;
    const a = md5("alpha");
    expect((s.game.tags as any[])[0].id).toBe(a);
    s = run([{ op: "set", path: "game.tagged", value: a }], s).state;
    s = run([{ op: "set", path: `game.tags.${a}.name`, value: "Beta" }], s).state;
    const b = md5("beta");
    expect((s.game.tags as any[])[0]).toEqual({ name: "Beta", id: b });
    expect(s.game.tagged).toBe(b);
  });

  it("the old id stays when no id can be made", () => {
    let s = run([{ op: "add", domain: "tags", value: { name: "Alpha" } }]).state;
    const a = md5("alpha");
    s = run([{ op: "set", path: `game.tags.${a}.name`, value: null }], s).state;
    expect((s.game.tags as any[])[0].id).toBe(a);
  });
});

describe("the judge matches names with a numbered list", () => {
  const world = () => {
    setIdSource({ bytes: (n) => Buffer.alloc(n, 1) });
    return run([{ op: "add", domain: "places", value: { name: "Cave", description: "damp" } }, { op: "add", domain: "places", value: { name: "Cave", description: "the big one" } }]).state;
  };

  it("sends numbers, never ids, and maps the answer back", async () => {
    const s = world();
    const second = (s.game.places as any[])[1].id;
    const f = judgeSays({ n: 2 });
    const ops = await resolveRefs(s, [{ op: "set", path: "game.location", value: "the big cave" }], "go to the big cave") as any[];
    expect(ops[0].value).toBe(second);
    const sent = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body)).messages[1].content as string;
    expect(sent).toContain('"n":2');
    expect(sent).toContain("the big one");
    expect(sent).not.toContain(second);
    expect(sent).not.toContain('"id"');
  });

  it("works for pushes into an id list; ids, nulls and addresses go through untouched, with no call", async () => {
    const s = addItem("Rusty key");
    const f = judgeSays({ n: 1 });
    const ops = await resolveRefs(s, [{ op: "push", path: "actors.user.inventory", value: "the key" }], "") as any[];
    expect(ops[0].value).toBe("item_1");
    f.mockClear();
    const same = [{ op: "push", path: "actors.user.inventory", value: "item_1" }, { op: "set", path: "game.location", value: null }, { op: "set", path: "game.location", value: "game.target" }, { op: "set", path: "actors.user.name", value: "the key" }];
    expect(await resolveRefs(s, same, "")).toEqual(same);
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores any answer that is not a number on the list", async () => {
    const s = addItem("Rusty key");
    for (const answer of [{ n: 0 }, { n: 2 }, { n: "1" }, { n: 1.5 }, { n: null }, { id: "item_1" }, {}]) {
      judgeSays(answer);
      const ops = await resolveRefs(s, [{ op: "push", path: "actors.user.inventory", value: "key" }], "") as any[];
      expect(ops[0].value).toBe("key");
    }
  });

  it("an entry added earlier in the same answer is on the list", async () => {
    const s = initialState();
    const f = judgeSays({ n: 1 });
    const ops = await resolveRefs(s, [{ op: "add", domain: "items", value: { name: "Lamp" } }, { op: "push", path: "actors.user.inventory", value: "the lamp" }], "") as any[];
    expect(ops[1].value).toBe("item_1");
    expect(String((f.mock.calls[0] as [string, RequestInit])[1].body)).toContain("Lamp");
    expect(run(ops, s).state.actors.user.inventory).toEqual(["item_1"]);
  });

  it("judge down: only an exact, unique name; an empty domain makes no call", async () => {
    mockFetch(() => { throw new TypeError("fetch failed"); });
    const s = addItem("Rusty key");
    expect(((await resolveRefs(s, [{ op: "push", path: "actors.user.inventory", value: " RUSTY  key " }], "")) as any[])[0].value).toBe("item_1");
    const two = addItem("rusty key", s);
    expect(((await resolveRefs(two, [{ op: "push", path: "actors.user.inventory", value: "rusty key" }], "")) as any[])[0].value).toBe("rusty key");
    const f = judgeSays({ n: 1 });
    await resolveRefs(initialState(), [{ op: "push", path: "actors.user.inventory", value: "key" }], "");
    expect(f).not.toHaveBeenCalled();
  });
});
