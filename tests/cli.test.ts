import { describe, it, expect } from "@jest/globals";
import { parseArgs, PERSIST, PREFLIGHT, PREFLIGHT_IGNORE } from "../src/utils/cli.js";

describe("cli flags", () => {
  it("persists by default", () => {
    expect(parseArgs([]).persist).toBe(true);
  });

  it("--no-persist turns persistence off", () => {
    expect(parseArgs(["--no-persist"]).persist).toBe(false);
  });

  it("--persist keeps it on", () => {
    expect(parseArgs(["--persist"]).persist).toBe(true);
  });

  it("preflight is off by default and on with --preflight", () => {
    expect(parseArgs([]).preflight).toBe(false);
    expect(parseArgs(["--preflight"]).preflight).toBe(true);
  });

  it("collects repeated --preflight-ignore ids", () => {
    expect(parseArgs([]).preflightIgnore).toEqual([]);
    expect(parseArgs(["--preflight-ignore", "ollama-exposed", "--preflight-ignore", "ctx-fit"]).preflightIgnore).toEqual(["ollama-exposed", "ctx-fit"]);
  });

  it("PREFLIGHT=1 in the environment turns preflight on (handy for Docker)", () => {
    for (const [value, expected] of [["1", true], ["true", true], ["ON", true], ["0", false], ["", false]] as const) {
      const before = process.env.PREFLIGHT;
      process.env.PREFLIGHT = value;
      expect(parseArgs([]).preflight).toBe(expected);
      if (before === undefined) delete process.env.PREFLIGHT; else process.env.PREFLIGHT = before;
    }
  });

  it("does not parse Jest's own argv under test", () => {
    expect(PERSIST).toBe(true);
    expect(PREFLIGHT).toBe(false);
    expect(PREFLIGHT_IGNORE).toEqual([]);
  });
});
