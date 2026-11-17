import { describe, it, expect } from "@jest/globals";
import { parseCard, cardName, score5, bestHand, showdown, compareScores } from "../src/tools/poker-eval.js";
import { settle } from "../src/tools/poker-settle.js";
import pokerTool from "../src/tools/poker.js";
import { REGISTRY } from "../src/tools/index.js";

const hand = (s: string) => s.split(" ").map(parseCard);
const ctx = (options: Record<string, any> = {}) => ({ options } as any);

describe("cards and five-card ranking", () => {
  it("reads several spellings and rejects nonsense", () => {
    expect(parseCard("7h")).toEqual({ rank: 7, suit: "h" });
    expect(cardName(parseCard("Ace of Spades"))).toBe("As");
    expect(cardName(parseCard("10 of clubs"))).toBe("10c");
    expect(parseCard("Td").rank).toBe(10);
    expect(() => parseCard("1x")).toThrow(/not a card/);
    expect(() => parseCard("king of cups")).toThrow(/not a card/);
  });
  it("orders every category, including the wheel and kickers", () => {
    const order = ["2c 5d 9h Js Kc", "2c 2d 9h Js Kc", "2c 2d 9h 9s Kc", "2c 2d 2h Js Kc", "Ac 2d 3h 4s 5c", "2c 6c 9c Jc Kc", "2c 2d 2h Ks Kc", "2c 2d 2h 2s Kc", "9c 10c Jc Qc Kc"].map((h) => score5(hand(h)));
    for (let i = 1; i < order.length; i++) expect(compareScores(order[i], order[i - 1])).toBeGreaterThan(0);
    expect(score5(hand("Ac 2d 3h 4s 5c"))).toEqual([4, 5]);
    expect(score5(hand("Ac 2c 3c 4c 5c"))).toEqual([8, 5]);
    expect(compareScores(score5(hand("Ac Kd 3h 4s 9c")), score5(hand("Ah Kc 3d 4h 8c")))).toBeGreaterThan(0);
    expect(() => score5(hand("2c 3c"))).toThrow(/five cards/);
  });
});

describe("best hands per variant", () => {
  it("holdem uses any five of seven", () => {
    const r = bestHand("holdem", hand("As Ks"), hand("Qs Js 10s 2c 3d"));
    expect(r.name).toBe("straight flush");
  });
  it("omaha must use exactly two hole cards and three board cards", () => {
    // a board flush of four spades is not a flush for omaha with one spade in hand
    const r = bestHand("omaha", hand("As 2d 3d 9c"), hand("Ks Qs Js 10s 2h"));
    expect(r.name).not.toBe("flush");
    expect(bestHand("omaha", hand("As 2s 3d 9c"), hand("Ks Qs Js 4d 2h")).name).toBe("flush");
    expect(() => bestHand("omaha", hand("As 2d"), hand("Ks Qs Js"))).toThrow(/four hole/);
  });
  it("stud5 is the five cards held; wrong counts are errors", () => {
    expect(bestHand("stud5", hand("2c 2d 2h 9s 9c"), []).name).toBe("full house");
    expect(() => bestHand("stud5", hand("2c 2d"), [])).toThrow(/five cards/);
    expect(() => bestHand("holdem", hand("2c 2d 3d"), hand("4c 5c 6c"))).toThrow(/two hole/);
  });
});

describe("showdown", () => {
  it("names winners, places and ties, and refuses a card dealt twice", () => {
    const r = showdown("holdem", ["2c", "7d", "9h", "Js", "Kc"], [{ id: "bea", hole: ["Ah", "Ad"] }, { id: "bo", hole: ["Ks", "Kd"] }, { id: "cy", hole: ["3h", "4h"] }]);
    expect(r.filter((x) => x.winner).map((x) => x.id)).toEqual(["bo"]);
    expect(r.map((x) => [x.id, x.place])).toEqual([["bea", 2], ["bo", 1], ["cy", 3]]);
    const tie = showdown("holdem", ["2c", "7d", "9h", "Js", "Kc"], [{ id: "a", hole: ["Ah", "3d"] }, { id: "b", hole: ["As", "3s"] }]);
    expect(tie.every((x) => x.winner)).toBe(true);
    expect(() => showdown("holdem", ["2c", "7d", "9h", "Js", "Kc"], [{ id: "a", hole: ["2c", "3d"] }])).toThrow(/dealt twice/);
    expect(() => showdown("razz" as any, [], [{ id: "a", hole: [] }])).toThrow(/unknown variant/);
    expect(() => showdown("holdem", [], [])).toThrow(/no hands/);
  });
});

describe("settle", () => {
  const h = (id: string, stack: number, bet: number, status: any, credit = 0) => ({ id, stack, bet, status, credit });
  it("pays the winner the pot; odd chips go to the first winner; a tie splits", () => {
    const r = settle([h("a", 100, 31, "in"), h("b", 100, 31, "in"), h("c", 100, 31, "folded")], ["a", "b"]);
    expect(r.pot).toBe(93);
    expect(r.payouts.map((p) => [p.id, p.payout, p.chips_after])).toEqual([["a", 47, 116], ["b", 46, 115], ["c", 0, 69]]);
    const extra = settle([h("a", 100, 30, "in"), h("b", 100, 30, "in"), h("c", 100, 31, "folded")], ["a", "b"]);
    expect(extra.payouts.map((p) => p.payout)).toEqual([45, 45, 1]); // the 1 chip nobody matched goes back
  });
  it("a player who goes all in and leaves: win and the winnings go to their account; lose and the pot goes to the winner", () => {
    const win = settle([h("gus", 200, 200, "left"), h("bea", 200, 200, "in")], ["gus"]);
    expect(win.payouts[0]).toMatchObject({ payout: 0, credit_after: 0 }); // a leaver folds by default: cannot win under "fold"
    const split = settle([h("gus", 200, 200, "left"), h("bea", 200, 200, "in")], ["gus"], { leave_rule: "split" });
    expect(split.payouts.map((p) => [p.id, p.payout, p.credit_after, p.chips_after])).toEqual([["gus", 400, 400, 0], ["bea", 0, 0, 0]]);
    expect(settle([h("gus", 200, 200, "left"), h("bea", 200, 200, "in")], ["bea"], { leave_rule: "split" }).payouts[1].payout).toBe(400);
    const lose = settle([h("gus", 250, 200, "left"), h("bea", 200, 200, "in")], ["bea"]);
    expect(lose.payouts[0]).toMatchObject({ payout: 0, chips_after: 0, credit_after: 50 });
    expect(lose.payouts[1]).toMatchObject({ payout: 400, chips_after: 400 });
  });
  it("split makes a side pot: the leaver can win only what each opponent matched; an over-bet nobody can win goes back", () => {
    const r = settle([h("gus", 50, 50, "left"), h("bea", 300, 200, "in"), h("bo", 300, 200, "in")], [], { leave_rule: "split", places: { gus: 1, bea: 2, bo: 3 } });
    expect(r.pots).toEqual([{ amount: 150, eligible: ["gus", "bea", "bo"], winners: ["gus"] }, { amount: 300, eligible: ["bea", "bo"], winners: ["bea"] }]);
    expect(r.payouts.map((p) => [p.id, p.payout, p.credit_after, p.chips_after])).toEqual([["gus", 150, 150, 0], ["bea", 300, 0, 400], ["bo", 0, 0, 100]]);
    const fold = settle([h("gus", 50, 50, "left"), h("bea", 300, 200, "in"), h("bo", 300, 200, "in")], [], { places: { gus: 1, bea: 2, bo: 3 } });
    expect(fold.payouts.map((p) => p.payout)).toEqual([0, 450, 0]); // folded: the leaver's 50 stays in the pot
    const over = settle([h("gus", 300, 300, "left"), h("bea", 100, 100, "in"), h("bo", 100, 100, "in")], ["bea"]);
    expect(over.pots.at(-1)).toEqual({ amount: 200, eligible: [], winners: [] });
    expect(over.payouts.map((p) => [p.id, p.payout])).toEqual([["gus", 200], ["bea", 300], ["bo", 0]]);
  });
  it("borrowing needs a limit; the shortfall is a negative credit, repaid from a win", () => {
    expect(() => settle([h("a", 10, 30, "in"), h("b", 100, 30, "in")], ["a"])).toThrow(/borrow limit 0/);
    const lose = settle([h("a", 10, 30, "in"), h("b", 100, 30, "in")], ["b"], { borrow_limit: 25 });
    expect(lose.payouts[0]).toMatchObject({ chips_after: 0, credit_after: -20 });
    const win = settle([h("a", 10, 30, "in"), h("b", 100, 30, "in")], ["a"], { borrow_limit: 25 });
    expect(win.payouts[0]).toMatchObject({ payout: 60, chips_after: 40, credit_after: 0 });
  });
  it("rejects bad input", () => {
    expect(() => settle([h("a", 1, 1, "in")], ["z"])).toThrow(/unknown winner/);
    expect(() => settle([h("a", -1, 1, "in")], ["a"])).toThrow(/zero or more/);
    expect(() => settle([h("a", 1, 1, "in")], ["a"], { leave_rule: "keep" as any })).toThrow(/fold or split/);
    expect(() => settle([h("a", 5, 5, "left")], [], {})).toThrow(/nobody is left/);
    expect(settle([h("a", 5, 5, "in"), h("b", 5, 5, "folded")], []).payouts[0].payout).toBe(10); // no named winner: the contenders share
  });
});

describe("the poker tool", () => {
  it("is registered and answers both actions, with errors as data", async () => {
    const t = await REGISTRY.poker();
    expect(t).toBe(pokerTool);
    const sd = await t.run({ action: "showdown", board: ["2c", "7d", "9h", "Js", "Kc"], seats: [{ id: "a", hole: ["Ah", "Ad"] }, { id: "b", hole: ["Ks", "Kd"] }] }, ctx());
    expect(sd).toMatchObject({ variant: "holdem", winners: ["b"] });
    const om = await t.run({ action: "showdown", board: ["2c", "7d", "9h", "Js", "Kc"], seats: [{ id: "a", hole: ["Ah", "Ad", "3s", "4s"] }] }, ctx({ variant: "omaha" }));
    expect(om).toMatchObject({ variant: "omaha", winners: ["a"] });
    const st: any = await t.run({ action: "settle", hands: [{ id: "a", stack: 100, bet: 10, status: "in" }, { id: "b", stack: 100, bet: 10, status: "left" }], winners: ["a"] }, ctx({ leave_rule: "split" }));
    expect(st.payouts.map((p: any) => p.payout)).toEqual([20, 0]);
    expect(sd).toMatchObject({ places: { a: 2, b: 1 } });
    expect(await t.run({ action: "nope" }, ctx())).toEqual({ error: "action is showdown or settle" });
    expect(await t.run({ action: "showdown", seats: [] }, ctx())).toEqual({ error: "no hands to rank" });
  });
});
