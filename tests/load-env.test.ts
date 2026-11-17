import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { loadEnv } from "../src/utils/load-env.js";

const KEYS = ["LE_A", "LE_B", "LE_C", "LE_D"];
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-env-"));
  file = path.join(dir, ".env");
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadEnv", () => {
  it("expands $VAR, ${VAR} and defaults", () => {
    fs.writeFileSync(file, "LE_A=pw\nLE_B=postgres://u:$LE_A@h/${LE_A}\nLE_C=${LE_D:-dflt}\n");
    loadEnv([], file);
    expect(process.env.LE_B).toBe("postgres://u:pw@h/pw");
    expect(process.env.LE_C).toBe("dflt");
  });

  it("keeps shell variables over the file", () => {
    process.env.LE_A = "shell";
    fs.writeFileSync(file, "LE_A=file\nLE_B=$LE_A/y\n");
    loadEnv([], file);
    expect(process.env.LE_A).toBe("shell");
    expect(process.env.LE_B).toBe("shell/y");
  });

  it("does nothing when Node was given --env-file", () => {
    fs.writeFileSync(file, "LE_A=x\n");
    loadEnv(["--env-file-if-exists=/dev/null"], file);
    expect(process.env.LE_A).toBeUndefined();
  });

  it("is silent when the file is missing", () => {
    expect(() => loadEnv([], path.join(dir, "absent"))).not.toThrow();
  });
});
