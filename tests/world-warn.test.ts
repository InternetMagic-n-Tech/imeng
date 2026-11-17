import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/world-warn");
const { WORLD, SESSION_RULES } = await import("../src/utils/config.js");
const { worldBlock } = await import("../src/utils/world.js");

describe("world: warn and keep", () => {
  it("warn adds no session rule, keep lets a traveller keep what they carry, and there is no reference without a canon file", () => {
    expect(WORLD).toMatchObject({ era: "far_future", timeTravel: "keep", anachronism: "warn", canon: "" });
    expect(SESSION_RULES.some((r: any) => r.id === "world_era")).toBe(false);
    const b = worldBlock();
    expect(b).toContain("far future");
    expect(b).toContain("keeps what they carry");
    expect(b).toContain("react in character");
    expect(b).not.toContain("Reference");
  });
});
