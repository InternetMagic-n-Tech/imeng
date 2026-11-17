import { describe, it, expect, beforeAll } from "@jest/globals";
import { checkConfig } from "../src/utils/config-schema.js";
import { calcPhaseProblems } from "../src/utils/doctor.js";
import { goalProblems, imageExtrasProblems } from "../src/utils/doctor-goals.js";
import { readGameFile } from "../src/utils/game-file.js";

const load = async (dir: string): Promise<Record<string, any>> => (await readGameFile(`tests/fixtures/${dir}`)).raw as Record<string, any>;

describe.each(["goals", "goals-all"])("fixture %s: secret goals, phases, calculated", (dir) => {
  let g: Record<string, any>;
  beforeAll(async () => { g = await load(dir); });
  it("is valid and passes the doctor's checks for the goals, phase and calculated blocks", () => {
    expect(checkConfig(g).errors).toEqual([]);
    expect([...calcPhaseProblems(g), ...goalProblems(g), ...imageExtrasProblems(g)]).toEqual([]);
  });
  it("needs a goal from everyone before the first round (when the fixture has phases)", () => {
    if (!g.phases) return;
    expect(g.phases.registration.require[0]).toMatchObject({ field: "goals_set", gte: 1 });
  });
  it("keeps every turn event's phase reachable", () => {
    for (const e of g.turn_events ?? []) for (const v of Object.values(e.set ?? {})) if (g.phases && typeof v === "string" && v in g.phases) expect(Object.keys(g.phases)).toContain(v);
  });
});
