import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import { checkConfig, gameConfigSchema } from "../src/utils/config-schema.js";
import { calcPhaseProblems } from "../src/utils/doctor.js";

const blocks = (file: string): string[] => [...fs.readFileSync(file, "utf8").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
const known = new Set(Object.keys(gameConfigSchema.shape));

/** Small models copy examples: every json example in the guide that is a config.json fragment must be valid as it stands. */
describe("docs/IMENG-MAKING.md examples", () => {
  const found = blocks("docs/IMENG-MAKING.md").flatMap((b) => { try { return [JSON.parse(b)]; } catch { return []; } }).filter((o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => known.has(k)));
  it("has config.json examples, and each one passes the schema and the doctor's checks", () => {
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const o of found) {
      expect(checkConfig(o).errors).toEqual([]);
      expect(calcPhaseProblems(o)).toEqual([]);
    }
  });
  it("has no unparsable json examples", () => {
    const bad = blocks("docs/IMENG-MAKING.md").filter((b) => { try { JSON.parse(b); return false; } catch { return true; } });
    expect(bad).toEqual([]);
  });
});
