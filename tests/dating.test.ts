import { describe, it, expect } from "@jest/globals";
import { stepAttraction, applyCheck, eligible, ageWord, npcPoint, finaleMatch, spend } from "../src/utils/dating.js";

const q = (kind: any, quote = "she said she loves cats too") => ({ kind, quote });
const bea = { id: "bea", age: 30, status: "single" }, bo = { id: "bo", age: 31, status: "single" }, cy = { id: "cy", age: 29, status: "dating" }, kid = { id: "kid", age: 16, status: "single" };

describe("attraction ladder", () => {
  it("moves one level per check, and only as far as the evidence reaches", () => {
    expect(stepAttraction(0, [q("interest")]).next).toBe(1);
    expect(stepAttraction(1, [q("interest")]).next).toBe(1); // a shared taste cannot lift past 1
    expect(stepAttraction(1, [q("physical")]).next).toBe(2);
    expect(stepAttraction(0, [q("passion")]).next).toBe(1); // never two levels at once
    expect(stepAttraction(2, [q("passion", "loves skydiving, my favourite thing")]).next).toBe(3);
    expect(stepAttraction(3, [q("passion")]).next).toBe(3);
  });
  it("needs a quote: narration alone is not evidence", () => {
    expect(stepAttraction(0, [q("interest", "")]).next).toBe(0);
    expect(stepAttraction(0, [q("interest", "  ")]).next).toBe(0);
  });
  it("a dislike drops exactly one level, even at 3 (the politics case)", () => {
    expect(stepAttraction(3, [q("dislike", "I could never date a Tory")]).next).toBe(2);
    expect(stepAttraction(3, [q("passion"), q("dislike", "opposite values")]).next).toBe(2);
    expect(stepAttraction(0, [q("dislike", "ew no thanks")]).next).toBe(-1); // repulsion
    expect(stepAttraction(-1, [q("dislike", "ew no thanks")])).toEqual({ next: -1, reason: "dislike, already at the floor" });
  });
});

describe("rules the code owns", () => {
  it("a minor is never above 0 and never eligible; the narrator hears adult or minor, never the age", () => {
    const r = applyCheck({}, bea, kid, [q("passion")]);
    expect(r.changed).toBe(false);
    expect(eligible(kid)).toBe(false);
    expect(eligible(cy)).toBe(false); // dating
    expect(eligible(bea)).toBe(true);
    expect(eligible({ ...bo, left: true })).toBe(false);
    expect([ageWord(bea), ageWord(kid), ageWord({ id: "x" })]).toEqual(["adult", "minor", "unknown"]);
  });
  it("is directed: A toward B does not move B toward A", () => {
    const r = applyCheck({}, bea, bo, [q("interest")]);
    expect(r.att.bea.bo).toBe(1);
    expect(r.att.bo?.bea).toBeUndefined();
  });
});

describe("the finale", () => {
  const att = { bea: { bo: 3, cy: 3 }, bo: { bea: 2 }, cy: { bea: 3 } };
  const people = [bea, bo, cy];
  it("an NPC points at the eligible person they like most, ties at random", () => {
    expect(npcPoint(att, "bea", people)).toBe("bo"); // cy is dating, so not eligible
    expect(npcPoint({ x: { bea: 2, bo: 2 } }, "x", people, () => 0.99)).toBe("bo");
    expect(npcPoint({ x: { bea: 1 } }, "x", people)).toBeNull();
  });
  it("crowns the first mutual pair of eligible people, both at 2 or 3, and only one", () => {
    expect(finaleMatch(att, { bea: "bo", bo: "bea", cy: "bea" }, people)).toEqual(["bea", "bo"]);
    expect(finaleMatch(att, { bea: "cy", cy: "bea" }, people)).toBeNull(); // cy is not eligible
    expect(finaleMatch({ bea: { bo: 3 }, bo: { bea: 1 } }, { bea: "bo", bo: "bea" }, people)).toBeNull(); // bo is only at 1
  });
});

describe("the show clock", () => {
  const cfg = { total: 22, costs: { question: 1, punishment: 3, crossing: 2, ad_break: 2 }, warn_at: [15, 20] };
  it("costs fixed minutes, warns once at each mark, and ends the show", () => {
    expect(spend(0, "question", cfg)).toEqual({ minutes: 1, over: false, warnings: [] });
    expect(spend(13, "punishment", cfg).warnings).toEqual([15]);
    expect(spend(19, "crossing", cfg)).toEqual({ minutes: 21, over: false, warnings: [20] });
    expect(spend(20, "punishment", cfg).over).toBe(true);
    expect(spend(5, "silence", cfg).minutes).toBe(5); // an hour of silence costs nothing
  });
});

describe("crowd boost", () => {
  const q = (kind: any) => ({ kind, quote: "I love hiking too" });
  it("a receptive crowd lifts one more step, never past its cap, and never on a dislike", () => {
    expect(stepAttraction(0, [q("interest")], 2).next).toBe(1);
    expect(stepAttraction(1, [q("interest")], 2).next).toBe(2);
    expect(stepAttraction(1, [q("interest")], 2).reason).toContain("crowd");
    expect(stepAttraction(2, [q("interest")], 2).next).toBe(2); // passion is still needed for 3
    expect(stepAttraction(1, [q("interest")], 0).next).toBe(1); // no crowd, no boost
    expect(stepAttraction(0, [q("interest")], -1)).toEqual({ next: 0, reason: "resisted the crowd" }); // a contrarian digs in
    expect(stepAttraction(1, [{ kind: "dislike", quote: "I hate hiking" }], -1).next).toBe(0);
    expect(stepAttraction(1, [{ kind: "dislike", quote: "I hate hiking" }], 2).next).toBe(0);
  });

});

describe("attraction is a gate, with repulsion below the floor of indifference", () => {
  const q = (kind: any, quote = "a quoted line"): any => ({ kind, quote });
  it("any quoted warmth takes -1 or 0 straight to 1 (the first gate); a shared taste cannot pass 1", () => {
    expect(stepAttraction(-1, [q("interest")]).next).toBe(1);
    expect(stepAttraction(0, [q("interest")]).next).toBe(1);
    expect(stepAttraction(1, [q("interest")]).next).toBe(1);
    expect(stepAttraction(1, [q("interest"), q("physical")]).next).toBe(2);
  });
  it("repulsion needs warmth to open the gate, nothing without a quote, and a dislike still wins", () => {
    expect(stepAttraction(-1, []).next).toBe(-1);
    expect(stepAttraction(-1, [q("interest", "")]).next).toBe(-1);
    expect(stepAttraction(-1, [q("interest"), q("dislike", "ew no thanks")]).next).toBe(-1);
    expect(stepAttraction(-1, [q("interest")], -1)).toEqual({ next: -1, reason: "resisted the crowd" });
  });
});
