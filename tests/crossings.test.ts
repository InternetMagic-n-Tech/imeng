import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/crossings");
const { crossNow } = await import("../src/utils/crossings.js");
const state = (over: any = {}) => ({ game: { phase: "crossing", area: "trivia area", ambient: "freezing", ...over }, actors: { user: { name: "you", warmth: 5 }, npc_0: { name: "Bo", warmth: 1 } } }) as any;

describe("crossings", () => {
  it("does nothing outside the crossing phase", () => {
    const s = state({ phase: "playing" });
    expect(crossNow(s)).toEqual([]);
    expect(s.actors.user.warmth).toBe(5);
  });
  it("rolls the ambient, moves the area, returns to playing", () => {
    const s = state();
    const lines = crossNow(s);
    expect(s.game.area).toBe("gak area");
    expect(s.game.phase).toBe("playing");
    expect(s.actors.user.warmth).toBe(3);
    expect(s.actors.npc_0.warmth).toBe(0);
    expect(lines.join(" ")).toContain("gak area");
  });
  it("heat is capped at the maximum", () => {
    const s = state({ ambient: "hot" });
    s.actors.user.warmth = 10;
    crossNow(s);
    expect(s.actors.user.warmth).toBe(10);
    expect(s.actors.npc_0.warmth).toBe(2);
  });
  it("issues one ad break on the second crossing, with no cooling, and never again", () => {
    const s = state();
    crossNow(s);
    s.game.phase = "crossing";
    const lines = crossNow(s);
    expect(s.game.area).toBe("trivia area");
    expect(lines.join(" ")).toContain("ad break");
    expect(s.actors.user.warmth).toBe(3);
    s.game.phase = "crossing";
    crossNow(s);
    expect(s.actors.user.warmth).toBe(1);
  });
});
