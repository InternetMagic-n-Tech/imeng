import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet");
const { tipCommand, tipsAfterTurn, npcTips, tipNote, tipAmount } = await import("../src/utils/tips.js");
const { parseCommand } = await import("../src/utils/commands.js");
const { TIPS } = await import("../src/utils/config.js");

beforeEach(() => { for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });
const st = (): any => ({ game: { phase: "between", big_blind: 10, hands_played: 0 }, actors: { table: { name: "Table" }, user: { name: "Bea", chips: 100, status: "in", controlled_by: "user" }, p_bo: { name: "Bo", chips: 100, status: "in", controlled_by: "user" }, npc_cy: { name: "Cy", chips: 100, status: "in", controlled_by: "npc" } } });
const sess = (s: any): any => ({ snapshots: [s], room: { players: { u1: { userId: "u1", name: "Bea", actor: "user" }, u2: { userId: "u2", name: "Bo", actor: "p_bo" } } }, announcements: [] });

describe("the tip jar", () => {
  it("is configured, and /tip is a command", () => {
    expect(TIPS).toMatchObject({ amount: "game.big_blind", after: 2, onLeave: true, npcChance: 0.5 });
    expect(parseCommand("/tip")).toMatchObject({ name: "tip" });
  });
  it("a tip is one blind from the stack into the jar, any time, never the last chip", async () => {
    const s = st(), x = sess(s);
    expect(tipAmount(s)).toBe(10);
    expect(await tipCommand(x, { userId: "u1", name: "Bea" })).toBe("Bea tips the dealer 10. The jar holds 10.");
    expect([s.actors.user.chips, s.game.tips, s.game.tip_idle]).toEqual([90, 10, 0]);
    s.actors.p_bo.chips = 10;
    expect(await tipCommand(x, { userId: "u2", name: "Bo" })).toMatch(/spare/);
    expect(s.actors.p_bo.chips).toBe(10);
    expect(await tipCommand(x, { userId: "zz", name: "Zed" })).toMatch(/not seated/);
    s.actors.user.status = "sitting out";
    expect(await tipCommand(x, { userId: "u1", name: "Bea" })).toMatch(/spare/);
  });
  it("coughs after N hands with no tip (counted from the state, so a command may have dealt them) and asks every seated real player privately; a tip resets the count", async () => {
    const before = st(), after = st(), x = sess(after);
    after.game.hands_played = 1;
    await tipsAfterTurn(x, before, after);
    expect([after.game.tip_idle, after.game.tip_notice, x.announcements.length]).toEqual([1, undefined, 0]);
    const b2 = structuredClone(after); after.game.hands_played = 2;
    await tipsAfterTurn(x, b2, after);
    expect(after.game.tip_notice).toBe(1); expect([after.game.tip_idle, after.game.tip_mark]).toEqual([0, 2]);
    expect(x.announcements.map((a: any) => [a.kind, a.to])).toEqual([["tip", "u1"], ["tip", "u2"]]);
    expect(x.announcements[0].text).toContain("/tip");
    expect(tipNote(after)).toContain("coughs");
    const b3 = structuredClone(after); after.game.hands_played = 3;
    await tipsAfterTurn(x, b3, after);
    expect(after.game.tip_notice).toBeUndefined(); expect(tipNote(after)).toBe("");
    const b4 = structuredClone(after); after.game.hands_played = 4; after.game.tip_mark = 4;
    await tipsAfterTurn(x, b4, after);
    expect(after.game.tip_notice).toBeUndefined();
  });
  it("a seated player leaving also sets it off, and the leaver is not asked; the table can set tip_after", async () => {
    const before = st(), after = st(), x = sess(after);
    after.actors.p_bo.status = "sitting out";
    await tipsAfterTurn(x, before, after);
    expect(after.game.tip_notice).toBe(1);
    expect(x.announcements.map((a: any) => a.to)).toEqual(["u1"]);
    const b = st(), a2 = st(), y = sess(a2); b.game.tip_after = 5; a2.game.tip_after = 5; a2.game.hands_played = 2;
    await tipsAfterTurn(y, b, a2);
    expect(a2.game.tip_notice).toBeUndefined();
  });
  it("a winning NPC may tip; a human winner or a low roll does not", () => {
    const s = st(); s.game.winners = ["npc_cy", "user"];
    expect(npcTips(s, () => 0)).toEqual(["Cy tips the dealer 10."]);
    expect([s.actors.npc_cy.chips, s.actors.user.chips, s.game.tips]).toEqual([90, 100, 10]);
    const t = st(); t.game.winners = ["npc_cy"];
    expect(npcTips(t, () => 0.9)).toEqual([]);
    expect(Array.isArray(npcTips(t))).toBe(true);
  });
});
