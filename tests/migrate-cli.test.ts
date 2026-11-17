import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateFile, main } from "../src/utils/migrate.js";
import { vNToVM } from "../src/utils/migrations/TEMPLATE.js";

beforeEach(() => { jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });

describe("migrateFile", () => {
  const text = JSON.stringify({ old_name: "x" });
  it("goes up and prints the notes", () => {
    const r = migrateFile(text, undefined, [vNToVM], 2);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.result!)).toEqual({ new_name: "x", schema_version: 2 });
    expect(r.out.join("\n")).toMatch(/1 -> 2: old_name renamed/);
    expect(r.out.join("\n")).toMatch(/do by hand: SYSTEM_PROMPT.md/);
  });
  it("rolls back with the rollback notes", () => {
    const r = migrateFile(JSON.stringify({ new_name: "x", schema_version: 2 }), 1, [vNToVM], 2);
    expect(JSON.parse(r.result!)).toEqual({ old_name: "x", schema_version: 1 });
    expect(r.out.join("\n")).toMatch(/Rolling back.*\n- 2 -> 1/);
    expect(r.out.join("\n")).toMatch(/Nothing is lost/);
  });
  it("says so when there is nothing to do, and fails on bad input", () => {
    const same = migrateFile("{}", undefined, [], 1);
    expect(same.code).toBe(0);
    expect(same.result).toBeUndefined();
    expect(migrateFile("{nope", undefined).code).toBe(1);
    expect(migrateFile("[]", undefined).code).toBe(1);
    expect(migrateFile("{}", 9, [], 1).code).toBe(1);
  });
});

describe("main", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  it("explains its usage and a missing config.json", () => {
    expect(main([])).toBe(2);
    expect(main(["x", "--to", "z"])).toBe(2);
    expect(main([tmp()])).toBe(1);
  });
  it("is a dry run without --write and leaves the file alone", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "config.json"), "{}");
    expect(main([d])).toBe(0);
    expect(fs.readdirSync(d)).toEqual(["config.json"]);
  });
  it("with --write saves the result and keeps the old file; --to rolls back", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "config.json"), '{"old_name":"x"}');
    expect(main([d, "--write"], [vNToVM], 2)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"))).toEqual({ new_name: "x", schema_version: 2 });
    expect(fs.readFileSync(path.join(d, "config.json.bak-v1"), "utf8")).toBe('{"old_name":"x"}');
    expect(main([d, "--to", "1", "--write"], [vNToVM], 2)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"))).toEqual({ old_name: "x", schema_version: 1 });
    expect(fs.existsSync(path.join(d, "config.json.bak-v2"))).toBe(true);
  });
  it("fails on a bad target version without writing", () => {
    const d = tmp(); fs.writeFileSync(path.join(d, "config.json"), "{}");
    expect(main([d, "--to", "7", "--write"], [], 1)).toBe(1);
    expect(fs.readdirSync(d)).toEqual(["config.json"]);
  });
});
