import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";

const load = (n: string): any => JSON.parse(fs.readFileSync(`imengs/${n}/config.json`, "utf8"));
const graph = (c: any): Record<string, string[]> => Object.fromEntries(Object.entries(c.phases).filter(([k]) => !["start", "texts"].includes(k)).map(([k, v]: [string, any]) => [k, [v.next ?? []].flat()]));
const walk = (g: Record<string, string[]>, path: string[]): boolean => path.every((p, i) => i === 0 || g[path[i - 1]!]!.includes(p));

describe("the shipped loops", () => {
  it("every phase's next exists, and the start is a phase", () => {
    for (const n of ["backrooms", "dungeon-game"]) {
      const c = load(n), g = graph(c);
      expect(Object.keys(g)).toContain(c.phases.start);
      for (const [, nx] of Object.entries(g)) for (const t of nx) expect(t === "@return" || t in g).toBe(true);
      expect(c.initial_state.game.phase).toBe(c.phases.start);
      for (const ph of Object.keys(g)) expect(c.allowed_values["imeng.phase"]).toContain(ph);
    }
  });
  it("Backrooms: setup > explore > encounter > chase > outcome > fog > explore, and dead goes to ended", () => {
    const g = graph(load("backrooms"));
    expect(walk(g, ["setup", "explore", "encounter", "chase", "outcome", "fog", "explore"])).toBe(true);
    expect(g.outcome).toContain("ended");
    expect(g.fog).not.toContain("ended");
  });
  it("Dungeon: the loop, a silent assess step, an interrupt magic phase, one to six players, and the dead are silenced", () => {
    const c = load("dungeon-game"), g = graph(c);
    expect(walk(g, ["setup", "explore", "combat", "post_combat", "explore", "interact", "assess_world", "interact", "assess_world", "explore", "sleep", "explore"])).toBe(true);
    expect(c.phases.assess_world.silent).toBe(true);
    expect(c.phases.magic.interrupt).toBe(true);
    expect(g.magic).toEqual(["@return"]);
    expect(c.multiplayer).toMatchObject({ enabled: true, max_players: 6, silenced_when: { field: "hp", lte: 0 } });
    expect(c.validate).toBe("hooks/validate.mjs");
  });
});

describe("the Dungeon validator", () => {
  it("refuses hp above max_hp and the dead coming back, allows the rest", async () => {
    const file = "../imengs/dungeon-game/hooks/validate.mjs";
    const { validateOp } = (await import(file)) as { validateOp: (op: unknown, state: unknown) => unknown };
    const state = { actors: { user: { hp: 5, max_hp: 8, level: 1 }, bo: { hp: 0, max_hp: 8 } } };
    expect(validateOp({ op: "inc", path: "actors.user.hp", value: 2 }, state)).toBe(true);
    expect(validateOp({ op: "inc", path: "actors.user.hp", value: 4 }, state)).toMatch(/max_hp/);
    expect(validateOp({ op: "set", path: "actors.bo.hp", value: 3 }, state)).toMatch(/dead/);
    expect(validateOp({ op: "set", path: "actors.user.gold", value: 10 }, state)).toBe(true);
  });
});
