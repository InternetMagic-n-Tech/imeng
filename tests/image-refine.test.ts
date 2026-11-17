import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/keepsake");
const { imageExtrasProblems } = await import("../src/utils/doctor-goals.js");
const { moveNegations, keepRecorded, refinePrompt } = await import("../src/utils/image-refine.js");
const { fillKeepsake } = await import("../src/utils/keepsake.js");
const { initialState } = await import("../src/utils/state.js");

describe("moveNegations", () => {
  it("moves a tag that starts with a negation word to the avoid list, once", () => {
    expect(moveNegations("a woman, no hats, without glasses, No Hats, studio", ["no", "without"])).toEqual({ prompt: "a woman, studio", avoid: ["hats", "glasses"] });
  });
  it("leaves words alone when the game lists none, and handles another language's words", () => {
    expect(moveNegations("not a hat, a cat", []).prompt).toBe("not a hat, a cat");
    expect(moveNegations("sin sombrero, un gato", ["sin"])).toEqual({ prompt: "un gato", avoid: ["sombrero"] });
  });
});

describe("keepRecorded", () => {
  it("adds the pictured actor's recorded values that are missing, and only those", () => {
    const s = initialState();
    s.actors.user.gak_colors = ["pink", "green"]; s.actors.user.outfit = "a green apron";
    expect(keepRecorded("a woman, pink gak", s, "user")).toBe("a woman, pink gak, green, a green apron");
    expect(keepRecorded("a woman", s, undefined)).toBe("a woman");
  });
});

describe("refinePrompt without a judge to ask", () => {
  it("falls back to the cleaned prompt", async () => {
    (globalThis as any).fetch = async () => { throw new TypeError("fetch failed"); };
    const r = await refinePrompt("a door, no people");
    expect(r).toEqual({ prompt: "a door", negative: "people" });
  });
});

describe("fillKeepsake", () => {
  it("fills the name, the game and actor fields, and drops unknown words", () => {
    const s = initialState();
    s.actors.user.name = "Bea"; s.actors.user.gak_colors = ["pink", "green"];
    expect(fillKeepsake("{name} in {gak_colors} at {game} {nothing}", s, "user")).toBe("Bea in pink, green at Gak Show");
  });
});

describe("doctor: image extras", () => {
  it("accepts a sound setup", () => {
    expect(imageExtrasProblems({ goals: {}, actor_template: { outfit: "" }, images: { keepsake: { options: "judge" }, state_fields: ["outfit"], refine: { max_words: 30, negations: ["no"], judge: { api: "openai", url: "http://x:1" } }, judge: { model: "m" } } })).toEqual([]);
    expect(imageExtrasProblems({})).toEqual([]);
  });
  it("flags what is wrong", () => {
    const p = imageExtrasProblems({ actor_template: {}, images: { keepsake: { options: [] }, state_fields: ["bad field", "ok"], keep_fields: "x" as any, refine: { max_words: 5, negations: [1] as any, judge: { api: "x" } }, judge: [] as any } }).join("|");
    for (const t of ["images.keepsake needs goals", "images.keepsake.options must be", "images.state_fields must be", "images.keep_fields must be", "images.refine.max_words", "images.refine.negations", "images.refine.judge needs", "images.judge must be an object"]) expect(p).toContain(t);
    expect(imageExtrasProblems({ goals: {}, images: { keepsake: {} } }).join()).toContain("options is needed");
    expect(imageExtrasProblems({ goals: {}, actor_template: {}, images: { state_fields: ["gone"] } }).join()).toContain('"gone" is not a field');
    expect(imageExtrasProblems({ images: { refine: 1 as any } }).join()).toContain("images.refine must be an object");
    expect(imageExtrasProblems({ images: { keepsake: 1 as any }, goals: {} }).join()).toContain("images.keepsake must be an object");
  });
});
