import { describe, it, expect } from "@jest/globals";
import { parseDurationMs, parseGameDuration, humanDuration } from "../src/utils/durations.js";

describe("durations", () => {
  it("parses written durations to milliseconds; a bare number or a word is not one", () => {
    expect(parseDurationMs("5d")).toBe(5 * 86_400_000);
    expect(parseDurationMs("5 days")).toBe(5 * 86_400_000);
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs("90 min")).toBe(5_400_000);
    expect(parseDurationMs("2 Weeks")).toBe(14 * 86_400_000);
    for (const v of ["5", "soon", "", "d5", null, 5, undefined]) expect(parseDurationMs(v)).toBeNull();
  });

  it("in-game durations are in the clock's unit; a counter takes a number and any word", () => {
    expect(parseGameDuration("2 hours", "minute")).toBe(120);
    expect(parseGameDuration("2 hours", "day")).toBeCloseTo(1 / 12);
    expect(parseGameDuration("5 days", "count")).toBe(5);
    expect(parseGameDuration(3, "count")).toBe(3);
    expect(parseGameDuration("3 rounds", "count")).toBe(3);
    expect(parseGameDuration("0 rounds", "count")).toBeNull();
    expect(parseGameDuration("soon", "minute")).toBeNull();
  });

  it("humanDuration", () => {
    expect(humanDuration(10_000)).toBe("under a minute");
    expect(humanDuration(61_000)).toBe("1 minute");
    expect(humanDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2 hours 5 minutes");
    expect(humanDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 days 4 hours");
  });
});
