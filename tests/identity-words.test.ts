import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/identity-strict");
const id = await import("../src/utils/identity.js");

describe("word link codes", () => {
  it("are three words from the game's list, matched without regard to case", async () => {
    const code = id.makeCode((n) => 0 % n);
    expect(code).toBe("amber-amber-amber");
    for (let i = 0; i < 50; i++) expect(id.makeCode()).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const c = id.issueCode({ userId: "a", name: "A" }, 0);
    expect((await id.redeemCode(c.toUpperCase(), { userId: "b", name: "B" }, 1000)).ok).toBe(true);
    expect(await id.linkTurn("", { userId: "a", name: "A" }, 0)).toContain("within 1 min");
  });
});
