import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/audience");
const { nextEnergy, audienceLines, crowdFor } = await import("../src/utils/audience.js");
describe("audience energy", () => {
  it("rises by the audience's lines, falls when quiet, stays in range", () => {
    expect(nextEnergy(2, 3, 10, 1)).toBe(5);
    expect(nextEnergy(9, 5, 10, 1)).toBe(10);
    expect(nextEnergy(0, 0, 10, 1)).toBe(0);
    expect(nextEnergy(4, 0, 10, 1)).toBe(3);
  });
  it("counts only lines of seats with the audience role, not private ones", () => {
    const st: any = { game: {}, actors: { a: { role: "audience" }, c: { role: "contestant" } } };
    const text = "[Bea (actors.a)] woo!\n[Cy (actors.c)] hi\n[Bea (actors.a)] PRIVATE: shh\n[Bea (actors.a)] boo!";
    expect(audienceLines(text, st, "audience")).toBe(2);
  });
});

describe("how open each person is to the crowd (suggestible, -1 to 3)", () => {
  const st = (e: number, s?: number): any => ({ game: { audience_energy: e }, actors: { a: s === undefined ? {} : { suggestible: s } } });
  it("0 or unset: unaffected; 1 to 3: sooner and higher; -1: digs in", () => {
    expect(crowdFor(st(10), "a")).toBe(0);
    expect(crowdFor(st(10, 0), "a")).toBe(0);
    expect(crowdFor(st(5, 1), "a")).toBe(0);   // below the threshold of 6
    expect(crowdFor(st(6, 1), "a")).toBe(1);   // capped at their own level
    expect(crowdFor(st(5, 2), "a")).toBe(2);   // threshold 5
    expect(crowdFor(st(4, 3), "a")).toBe(2);   // threshold 4, config cap 2
    expect(crowdFor(st(3, 3), "a")).toBe(0);
    expect(crowdFor(st(7, -1), "a")).toBe(-1);
    expect(crowdFor(st(2, -1), "a")).toBe(0);
    expect(crowdFor(st(9, 99), "a")).toBe(2);  // clamped to 3
  });
});
