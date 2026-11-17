import { describe, it, expect } from "@jest/globals";
import { newDeck, shuffle, newDeal, ritualStep, dealHole, dealBoard } from "../src/utils/poker-deal.js";

describe("server-side poker deal", () => {
  it("a deck has 52 distinct cards and a shuffle keeps all of them", () => {
    const d = newDeck();
    expect(new Set(d).size).toBe(52);
    expect([...shuffle(d)].sort()).toEqual([...d].sort());
  });
  it("nothing is dealt until the deck is shuffled; a ritual must be done in order", () => {
    const d = newDeal("holdem", ["riffle 7", "cut"]);
    expect(dealHole(d, ["a", "b"]).ok).toBe(false);
    expect(ritualStep(d, "cut").ok).toBe(false);
    expect(ritualStep(d, "Riffle  7").ok).toBe(true);
    expect(d.shuffled).toBe(false);
    expect(ritualStep(d, "cut").text).toBe("The deck is shuffled.");
    expect(dealHole(d, ["a", "b"]).ok).toBe(true);
  });
  it("hold'em: two each, then a burned flop, turn and river in order, no card twice", () => {
    const d = newDeal("holdem");
    ritualStep(d, "");
    dealHole(d, ["a", "b", "c"]);
    expect(d.hole.a).toHaveLength(2);
    expect(dealBoard(d, "turn").ok).toBe(false);
    dealBoard(d, "flop"); dealBoard(d, "turn"); dealBoard(d, "river");
    expect(d.board).toHaveLength(5);
    const all = [...Object.values(d.hole).flat(), ...d.board, ...d.deck];
    expect(new Set(all).size).toBe(all.length);
    expect(d.deck).toHaveLength(52 - 6 - 5 - 3); // dealt, board, three burns
  });
  it("omaha deals four, stud five with no board", () => {
    const o = newDeal("omaha"); ritualStep(o, ""); dealHole(o, ["a"]); expect(o.hole.a).toHaveLength(4);
    const s = newDeal("stud5"); ritualStep(s, ""); dealHole(s, ["a"]); expect(s.hole.a).toHaveLength(5);
    expect(dealBoard(s, "flop").ok).toBe(false);
  });
});
