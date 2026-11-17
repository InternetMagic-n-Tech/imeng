import { describe, it, expect } from "@jest/globals";
import { normalizePrompt, samePrompt, matchVersion, unifiedDiff } from "../src/utils/prompt-match.js";

describe("prompt matching", () => {
  it("ignores comments, punctuation and white space", () => {
    expect(normalizePrompt("Hello,  world!\n<!-- note -->\nBye.")).toBe("Hello world Bye");
    expect(samePrompt("You are the Host.\n\nBe kind!", "You are the Host   Be kind")).toBe(true);
    expect(samePrompt("Be kind", "Be cruel")).toBe(false);
  });
  it("finds the newest stored version that matches", () => {
    const v = [{ version: 1, text: "Be kind." }, { version: 2, text: "Be cruel." }, { version: 3, text: "Be  kind," }, { version: 4 }];
    expect(matchVersion("Be kind!", v)?.version).toBe(3);
    expect(matchVersion("Other", v)).toBeNull();
  });
  it("diffs normalised words, empty when the same", () => {
    expect(unifiedDiff("Be kind.", "be kind".replace("be", "Be"))).toBe("");
    const d = unifiedDiff("Be very kind", "Be kind")!;
    expect(d).toContain("-very");
    expect(unifiedDiff("a", "b", (() => ({ error: new Error("nope") })) as any)).toBeNull();
  });
});
