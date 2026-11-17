import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGameFile, gameFileOf, gameFolders } from "../src/utils/game-file.js";
import { checkConfig } from "../src/utils/config-schema.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "gamefile-"));

describe("game settings files", () => {
  it("does not read the old imeng.json or game.json names, and ignores config.generated.json", async () => {
    const d = tmp();
    for (const n of ["imeng.json", "game.json", "config.generated.json"]) fs.writeFileSync(path.join(d, n), '{"model_id":"old"}');
    expect((await readGameFile(d)).file).toBeNull();
    fs.writeFileSync(path.join(d, "config.json"), '{"model_id":"new"}');
    expect((await readGameFile(d)).raw).toEqual({ model_id: "new" });
  });
  it("reads a config.mjs whose default export is a function (async is fine) and the settings pass the same check", async () => {
    const r = await readGameFile("tests/fixtures/jsconfig");
    expect(r.file).toMatch(/config\.mjs$/);
    expect(r.raw).toMatchObject({ model_id: "js-config-game", limits: { hp: { max: 10 } } });
    expect(checkConfig(r.raw).errors).toEqual([]);
  });

  it("reads an object export and a json file, and prefers config.mjs over config.json", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ model_id: "from-json" }));
    expect((await readGameFile(d)).raw).toMatchObject({ model_id: "from-json" });
    fs.writeFileSync(path.join(d, "config.mjs"), "export default { model_id: 'from-js' };\n");
    expect((await readGameFile(d)).raw).toMatchObject({ model_id: "from-js" });
    expect(gameFileOf(d)).toMatch(/config\.mjs$/);
  });

  it("has no settings in a folder without a file", async () => {
    expect(await readGameFile(tmp())).toEqual({ raw: {}, file: null });
  });

  it("names the file when it cannot be read", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "config.mjs"), "export default {;\n");
    await expect(readGameFile(d)).rejects.toThrow(/config\.mjs could not be read/);
    fs.rmSync(path.join(d, "config.mjs"));
    fs.writeFileSync(path.join(d, "config.json"), "{ nope");
    await expect(readGameFile(d)).rejects.toThrow(/config\.json could not be read/);
  });


  it("finds game folders at any depth and skips folders that are not games", () => {
    const d = tmp();
    for (const p of ["a", "b/one", "b/two", "b/prompts"]) fs.mkdirSync(path.join(d, p), { recursive: true });
    fs.writeFileSync(path.join(d, "a/config.json"), "{}");
    fs.writeFileSync(path.join(d, "b/one/config.mjs"), "export default {};");
    fs.writeFileSync(path.join(d, "b/two/config.json"), "{}");
    fs.writeFileSync(path.join(d, "b/prompts/config.json"), "{}");
    expect(gameFolders(d).map((x) => path.relative(d, x))).toEqual(["a", "b/one", "b/two"]);
    expect(gameFolders("/nope")).toEqual([]);
  });
});
