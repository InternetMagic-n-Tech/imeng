import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { gameFolders, gameFileOf, readGameFile } from "../src/utils/game-file.js";
import { checkConfig, jsonSchema, CONFIG_SCHEMA_VERSION } from "../src/utils/config-schema.js";
import { runMigrations, chainError, MIGRATIONS, type Migration } from "../src/utils/migrations/index.js";
import { vNToVM } from "../src/utils/migrations/TEMPLATE.js";
import { versionNote } from "../src/utils/sessions.js";

const shipped = gameFolders("imengs");
const files = [
  ...shipped.map((d) => gameFileOf(d)!),
  ...fs.readdirSync("tests/fixtures").map((d) => path.join("tests/fixtures", d, "config.json")),
].filter((f) => fs.existsSync(f));

describe("every shipped config.json", () => {
  it.each(files)("%s has no errors and no unknown keys", async (f) => {
    const raw = f.endsWith(".json") ? JSON.parse(fs.readFileSync(f, "utf8")) : (await readGameFile(path.dirname(f))).raw;
    const r = checkConfig(raw);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("checkConfig", () => {
  it("accepts an empty file as the current version", () => {
    expect(checkConfig({})).toMatchObject({ version: 1, errors: [], warnings: [] });
  });
  it("reports wrong types with the key path", () => {
    const r = checkConfig({ history_limit: "20", limits: { hp: { max: "x" } }, reasoning: "loud" });
    expect(r.errors.join("\n")).toMatch(/history_limit/);
    expect(r.errors.join("\n")).toMatch(/limits\.hp\.max/);
    expect(r.errors.join("\n")).toMatch(/reasoning/);
  });
  it("warns about unknown keys but does not stop", () => {
    const r = checkConfig({ histroy_limit: 5 });
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toMatch(/histroy_limit/);
  });
  it("rejects a non-object and a bad schema_version", () => {
    expect(checkConfig([]).errors[0]).toMatch(/JSON object/);
    expect(checkConfig(null).errors[0]).toMatch(/JSON object/);
    expect(checkConfig({ schema_version: 0 }).errors[0]).toMatch(/schema_version/);
    expect(checkConfig({ schema_version: "1" }).errors[0]).toMatch(/schema_version/);
  });
  it("refuses a newer format than the engine knows", () => {
    expect(checkConfig({ schema_version: CONFIG_SCHEMA_VERSION + 1 }).errors[0]).toMatch(/understands up to/);
  });
  it("migrates step by step, warns, and never edits the input", () => {
    const m: Migration[] = [vNToVM, { ...vNToVM, from: 2, to: 3, up: (c) => ({ ...c, state_rules: "r" }), down: ({ state_rules, ...c }) => c }];
    const input = { old_name: "x" };
    const r = checkConfig(input, 3, m);
    expect(r.errors).toEqual([]);
    expect(r.config).toMatchObject({ new_name: "x", state_rules: "r", schema_version: 3 });
    expect(r.warnings[0]).toMatch(/upgraded in memory to 3.*npm run migrate/);
    expect(input).toEqual({ old_name: "x" });
  });
  it("fails when the chain has a gap", () => {
    expect(checkConfig({}, 2, []).errors[0]).toMatch(/versions must be between/);
  });
});

describe("migrations folder", () => {
  it("the real chain is gapless and gives the current version", () => {
    expect(chainError(MIGRATIONS)).toBeNull();
    expect(CONFIG_SCHEMA_VERSION).toBe(1 + MIGRATIONS.length);
  });
  it("up then down gives the original back (template migration)", () => {
    const orig = { old_name: "x", model_id: "m" };
    const up = runMigrations(orig, 1, 2, [vNToVM]);
    expect(up).toMatchObject({ direction: "up", config: { new_name: "x", schema_version: 2 } });
    const down = runMigrations(up.config, 2, 1, [vNToVM]);
    expect(down).toMatchObject({ direction: "down", config: { old_name: "x", model_id: "m", schema_version: 1 } });
    expect(down.steps).toEqual([vNToVM]);
  });
  it("does nothing between equal versions and rejects bad ones", () => {
    expect(runMigrations({}, 1, 1, [])).toMatchObject({ direction: "none", steps: [] });
    expect(runMigrations({}, 1, 5, [vNToVM]).error).toMatch(/between 1 and 2/);
    expect(runMigrations({}, 0, 1, []).error).toMatch(/between/);
    expect(runMigrations({}, 1, 2, [{ ...vNToVM, from: 2, to: 3 }]).error).toMatch(/must go from 1 to 2/);
  });
});

describe("imeng.schema.json", () => {
  it("is up to date (run `npm run schema`)", () => {
    expect(JSON.parse(fs.readFileSync("imeng.schema.json", "utf8"))).toEqual(JSON.parse(JSON.stringify(jsonSchema())));
  });
});

describe("versionNote", () => {
  it("stays quiet when the major version matches or the game has no version", () => {
    expect(versionNote("1.2.0", "1.9.3")).toBeNull();
    expect(versionNote("1.0.0", null)).toBeNull();
    expect(versionNote(null, null)).toBeNull();
  });
  it("flags a major change and a save with no recorded version", () => {
    expect(versionNote("1.4.0", "2.0.0")).toMatch(/major change/);
    expect(versionNote(null, "2.0.0")).toMatch(/no game version/);
  });
});

describe("shipped games stay in step with the proxy", () => {
  const root = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  const dirs = shipped;
  it.each(dirs)("%s has a package.json whose proxy_version is the proxy's version", (d) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
    expect(pkg.proxy_version).toBe(root); // bump the root version? retest the shipped games and update this field
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
