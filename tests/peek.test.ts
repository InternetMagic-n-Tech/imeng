import { describe, it, expect, beforeEach } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-peek");
const { peekCommand, revealCheck, guardReveal, guardViewer, oddsCommand, cardsIn } = await import("../src/utils/peek.js");

const bea = { userId: "u-bea", name: "Bea" }, bo = { userId: "u-bo", name: "Bo" }, cy = { userId: "u-cy", name: "Cy" };
const mk = (phase = "preflop"): any => ({
  snapshots: [{ game: { phase, hand: 3 }, actors: { a: { hole: ["ace of hearts", "king of diamonds"] }, b: { hole: ["7 of clubs", "7 of spades"] }, c: { hole: ["2h", "9s"] } } }],
  room: { players: { "u-bea": { ...bea, actor: "a" }, "u-bo": { ...bo, actor: "b" }, "u-cy": { ...cy, actor: "c" } } },
  owner: { userId: "u-bea", name: "Bea" },
});
let s: any;
beforeEach(() => { s = mk(); });

describe("cards in text", () => {
  it("reads words and short forms", () => { expect([...cardsIn("he has the ace of hearts and 7c, maybe the Kd")].sort()).toEqual(["7c", "Ah", "Kd"].sort()); });
});

describe("/peek", () => {
  it("is private-chat only", async () => { expect(await peekCommand(s, "t", bo, "Bea", false)).toContain("private chat"); });
  it("your own cards are never a peek, whatever the phase", async () => {
    s = mk("river");
    expect(await peekCommand(s, "t", bo, "Bo", true)).toContain("Looking at your own cards is never a peek");
    expect(s.bans).toBeUndefined();
  });
  it("at the start of the hand, once, at one person: shown, and the owner is told", async () => {
    expect(await peekCommand(s, "t", bo, "Cy", true)).toContain("Cy's cards: 2h, 9s");
    expect(s.announcements.at(-1)).toMatchObject({ kind: "peek", to: "u-bea", text: "Bo looked at Cy's cards at the start of hand 3." });
    expect(s.bans).toBeUndefined();
  });
  it("a second look in the same hand, or a look later in it, is a caught peek: a 12 hour ban, owner told, no cards", async () => {
    await peekCommand(s, "t", bo, "Cy", true);
    const r = await peekCommand(s, "t", bo, "Bea", true);
    expect(r).toContain("you are out of the game until"); expect(r).not.toContain("ace");
    expect(s.bans["u-bo"]).toBeGreaterThan(Date.now() + 11 * 3_600_000);
    s = mk("flop");
    expect(await peekCommand(s, "t", cy, "Bea", true)).toContain("out of the game");
    expect(s.announcements.at(-1).kind).toBe("peek_caught");
  });
});

describe("announcing a hand", () => {
  it("a correct whole hand is refused and bans for a week; a wrong guess costs nothing", async () => {
    const w = await guardReveal(s, "t", cy, "Bo is holding the seven of clubs and the 7 of spades!");
    expect(w!.text).toContain("out of the game until"); expect(w!.kick).toMatchObject({ userId: "u-cy" });
    expect(s.bans["u-cy"]).toBeGreaterThan(Date.now() + 160 * 3_600_000);
    const t = mk();
    expect(await guardReveal(t, "t", cy, "Bo has the ace of clubs and the 7 of spades")).toBeNull();
    expect(t.bans).toBeUndefined();
  });
  it("your own hand is yours to say; at the showdown hands are shown", async () => {
    expect(revealCheck(s, bo, "I have 7 of clubs and 7 of spades")).toBeNull();
    expect(revealCheck(mk("showdown"), cy, "Bo had 7c 7s")).toBeNull();
  });
  it("someone who peeked cannot repeat what they saw, even one card, but is not banned", async () => {
    await peekCommand(s, "t", bo, "Cy", true);
    expect((await guardReveal(s, "t", bo, "Cy looks nervous, I think the 9 of spades"))!.text).toContain("not sent");
    expect(s.bans).toBeUndefined();
  });
});

describe("swaying the table", () => {
  it("one try in a hand is heckling and goes through; a second in the same hand is out for 24 hours", async () => {
    expect(await guardReveal(s, "t", cy, "Bo has the ace of clubs and the 7 of hearts")).toBeNull();
    const second = await guardReveal(s, "t", cy, "no wait, Bo has just the king of clubs");
    expect(second!.text).toContain("second try"); expect(second!.kick).toBeTruthy();
    expect(s.bans["u-cy"]).toBeGreaterThan(Date.now() + 23 * 3_600_000); expect(s.bans["u-cy"]).toBeLessThan(Date.now() + 25 * 3_600_000);
  });
  it("a new hand starts the count again", async () => {
    await guardReveal(s, "t", cy, "Bo has the ace of clubs");
    s.snapshots[0].game.hand = 4;
    expect(await guardReveal(s, "t", cy, "Bo has the king of clubs")).toBeNull();
    expect(s.bans).toBeUndefined();
  });
  it("a peek followed by correct-sounding talk counts: the peeker's repeat is refused, the second is out", async () => {
    await peekCommand(s, "t", bo, "Cy", true);
    expect((await guardReveal(s, "t", bo, "Cy has the 9 of spades"))!.text).toContain("not sent");
    expect((await guardReveal(s, "t", bo, "Cy has the 2 of hearts"))!.kick).toBeTruthy();
  });
  it("talking about cards without naming anyone is not an attempt", async () => {
    expect(await guardReveal(s, "t", cy, "I love the ace of hearts and the king of spades")).toBeNull();
    expect(s.guesses).toBeUndefined();
  });
});

describe("watching without a seat", () => {
  const zed = { userId: "u-zed", name: "Zed" };
  it("seated players cannot ask for the hands", () => { expect(oddsCommand(s, bo)).toContain("only for people watching without a seat"); expect(s.viewers).toBeUndefined(); });
  it("an onlooker sees every live hand with winning chances that add up", () => {
    s.snapshots[0].actors.table = { board: ["2s", "3d", "8c"] };
    const out = oddsCommand(s, zed, () => 0.5, 300);
    expect(out).toContain("Hand 3, preflop. Board: 2s 3d 8c."); expect(out).toContain("Bea: Ah Kd"); expect(out).toContain("Bo: 7c 7s");
    const pcts = [...out.matchAll(/\(([\d.]+)%\)/g)].map((m) => Number(m[1]));
    expect(pcts).toHaveLength(3); expect(Math.round(pcts.reduce((a, b) => a + b, 0))).toBe(100);
    expect(s.viewers["u-zed"]).toBe(3);
  });
  it("any comment from someone who asked for the odds, in that hand, is out for 24 hours; the next hand frees them", async () => {
    oddsCommand(s, zed, () => 0.5, 200);
    const r = await guardViewer(s, "t", zed, "nice game everyone");
    expect(r!.kick).toBeTruthy();
    expect(s.bans["u-zed"]).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const t = mk(); oddsCommand(t, zed, () => 0.5, 200);
    t.snapshots[0].game.hand = 4;
    expect(await guardViewer(t, "t", zed, "can I play now")).toBeNull();
  });
});
