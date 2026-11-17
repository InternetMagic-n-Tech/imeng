import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import { CONFIG_SCHEMA_VERSION } from "../src/utils/migrations/index.js";

/** docs/IMENG-MAKING.md carries a stamp of the config format it documents, so a format change cannot leave the guide behind. */
describe("docs/IMENG-MAKING.md", () => {
  it("is stamped with the schema_version the engine reads", () => {
    const m = /^<!-- IMENG-MAKING stamp: schema_version (\d+); schema file (imeng\.schema-v\.\d+\.\d+\.\d+\.json) -->/.exec(fs.readFileSync("docs/IMENG-MAKING.md", "utf8"));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("describes every multiplayer key the engine accepts", () => {
    const guide = fs.readFileSync("docs/IMENG-MAKING.md", "utf8") + fs.readFileSync("docs/MULTIPLAYER.md", "utf8");
    const schema = JSON.parse(fs.readFileSync("imeng.schema.json", "utf8"));
    for (const key of Object.keys(schema.properties.multiplayer.properties)) expect(guide).toContain("`" + key + "`");
  });
});
