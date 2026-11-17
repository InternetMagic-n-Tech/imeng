import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/world");
const { WORLD, SESSION_RULES } = await import("../src/utils/config.js");
const { worldBlock } = await import("../src/utils/world.js");
const { initialState } = await import("../src/utils/state.js");

describe("world: era, time travel, canon and anachronisms", () => {
  it("is read from config.json, with the canon file inside the imeng folder", () => {
    expect(WORLD).toMatchObject({ era: "1990s", timeTravel: "none", anachronism: "block", canonName: "The Sample World" });
    expect(WORLD!.canon).toContain("tide clock");
  });
  it("block adds a locked session rule the audit enforces, present in the starting state", () => {
    expect(SESSION_RULES.find((r: any) => r.id === "world_era")).toMatchObject({ locked: true });
    expect((initialState().game.rules as any).world_era).toBeTruthy();
  });
  it("the narrator is told the setting every round: era, no time travel, the policy and the reference", () => {
    const b = worldBlock();
    expect(b).toContain("## THE WORLD");
    expect(b).toContain("1990s");
    expect(b).toContain("no time travel");
    expect(b).toContain("do not know what it is");
    expect(b).toContain("The tide clock rings every hour.");
  });
  it("tongues and the universe are read and told to the narrator", () => {
    expect(WORLD).toMatchObject({ languages: ["common", "tidespeak"], languageField: "tongues", universe: "Tide-3", universeJump: "allowed" });
    const b = worldBlock();
    expect(b).toContain("common, tidespeak");
    expect(b).toContain('"tongues"');
    expect(b).toContain('universe "Tide-3"');
    expect(b).toContain("only for a reason the game's rules give");
  });
});
