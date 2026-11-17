import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-hand");
const { handCommand } = await import("../src/utils/hands-private.js");

const session: any = { snapshots: [{ actors: { p_bea: { hole: ["Ah", "Kd"] }, p_bo: { hole: [] } } }], room: { players: { "u-bea": { userId: "u-bea", name: "Bea", actor: "p_bea" }, "u-bo": { userId: "u-bo", name: "Bo", actor: "p_bo" } } } };
describe("/hand", () => {
  it("shows your own cards in your private chat only", () => {
    expect(handCommand(session, { userId: "u-bea", name: "Bea" }, true)).toBe("Your hand: Ah, Kd.");
    expect(handCommand(session, { userId: "u-bo", name: "Bo" }, true)).toBe("You have no cards right now.");
    expect(handCommand(session, { userId: "u-zed", name: "Zed" }, true)).toBe("You are not seated at this table.");
  });
  it("in the shared chat it says nothing about any hand, not even whether you have one", () => {
    for (const u of ["u-bea", "u-bo"]) { const r = handCommand(session, { userId: u, name: "x" }, false); expect(r).toContain("Hands are private"); expect(r).not.toMatch(/Ah|Kd|no cards/); }
  });
});


describe("a private answer cannot hand one player another's cards", () => {
  it("blanks every other actor's private hand and leaves the asker's own", async () => {
    const { hideOthersHands } = await import("../src/utils/table.js");
    const s: any = { game: {}, actors: { user: { hole: ["Jh", "6s"] }, p_bo: { hole: ["Kh", "5d"] }, table: { board: ["2c"] } } };
    const seen: any = hideOthersHands(s, "p_bo");
    expect(seen.actors.p_bo.hole).toEqual(["Kh", "5d"]);
    expect(seen.actors.user.hole).toEqual([]);
    expect(seen.actors.table.board).toEqual(["2c"]);
    expect(s.actors.user.hole).toEqual(["Jh", "6s"]); // the real state is untouched
  });
});
