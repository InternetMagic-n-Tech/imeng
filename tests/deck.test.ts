import { describe, it, expect } from "@jest/globals";
import { freshDeck, draw, putBack, multiplier, effectiveness, cardId } from "../src/utils/deck.js";

describe("deck", () => {
  it("has 52 unique cards", () => { const d = freshDeck(); expect(d.length).toBe(52); expect(new Set(d.map(cardId)).size).toBe(52); });
  it("draws from the top and never duplicates a held card", () => {
    const d = freshDeck(() => 0.5);
    const held = [d[0]!];
    const r = draw(d, 2, held);
    expect(r.cards.map(cardId)).toEqual([cardId(d[1]!), cardId(d[2]!)]);
    expect(r.deck.length).toBe(50);
    expect(r.deck.map(cardId)).toContain(cardId(d[0]!)); // the held card stays in the deck list but is skipped
  });
  it("puts played cards back in the bottom half", () => {
    const d = freshDeck(() => 0.5), { cards, deck } = draw(d, 1);
    for (let i = 0; i < 20; i++) { const b = putBack(deck, cards, () => i / 20); expect(b.length).toBe(52); expect(b.findIndex((c) => cardId(c) === cardId(cards[0]!))).toBeGreaterThanOrEqual(25); }
  });
  it("values", () => {
    expect([multiplier({ rank: "3", suit: "hearts" }), multiplier({ rank: "7", suit: "hearts" }), multiplier({ rank: "K", suit: "hearts" }), multiplier({ rank: "A", suit: "hearts" })]).toEqual([0.5, 1, 1.25, 1.5]);
    expect(effectiveness({ rank: "A", suit: "spades" }, "aligned")).toBeCloseTo(1.875);
    expect(effectiveness({ rank: "7", suit: "spades" }, "opposed")).toBeCloseTo(0.75);
  });
});

import { parseCard, deal, play } from "../src/utils/deck.js";
describe("hands", () => {
  it("reads a named card in the ways people write it", () => {
    expect(parseCard("I play the 7 of spades")).toEqual({ rank: "7", suit: "spades" });
    expect(parseCard("queen of hearts please")).toEqual({ rank: "Q", suit: "hearts" });
    expect(parseCard("ace spades")).toEqual({ rank: "A", suit: "spades" });
    expect(parseCard("10d")).toEqual({ rank: "10", suit: "diamonds" });
    expect(parseCard("I cast a spell")).toBeNull();
  });
  it("deals a hand, plays a card from it, and tops the hand back up with no duplicate", () => {
    const d = freshDeck(() => 0.3);
    const a = deal(d, 3);
    expect(a.hand.length).toBe(3);
    const b = play(a.deck, a.hand, a.hand[1]!, () => 0.5)!;
    expect(b.hand.length).toBe(3);
    expect(b.hand.map(cardId)).not.toContain(cardId(a.hand[1]!));
    expect(new Set(b.hand.map(cardId)).size).toBe(3);
    expect(b.deck.length + b.hand.length).toBe(52);
    expect(play(a.deck, [{ rank: "5", suit: "hearts" }], { rank: "6", suit: "hearts" })).toBeNull(); // not in the hand
  });
});

import { alignmentOf, handsRound } from "../src/utils/deck.js";
describe("suit alignment", () => {
  it("same suit aligned, same colour neutral, other colour opposed, no suit neutral", () => {
    const c = { rank: "7", suit: "hearts" as const };
    expect(alignmentOf(c, "hearts")).toBe("aligned");
    expect(alignmentOf(c, "diamonds")).toBe("neutral");
    expect(alignmentOf(c, "spades")).toBe("opposed");
    expect(alignmentOf(c, undefined)).toBe("neutral");
  });
  it("changes the strength the narrator is told, not whether a card plays", () => {
    const store = { cards: freshDeck(() => 0.2), hands: { a: [{ rank: "7", suit: "hearts" as const }, { rank: "2", suit: "clubs" as const }, { rank: "9", suit: "clubs" as const }] } };
    const out = handsRound(store, [{ id: "a", name: "Bea", text: "I play the 7 of hearts" }], 3, "Resolve it.", () => 0.5, (_id, c) => alignmentOf(c, "spades"));
    expect(out).toContain("strength x0.75 (opposed by suit)");
  });
});

import { combine, classAlignment } from "../src/utils/deck.js";
describe("class and spell together", () => {
  it("adds the spell's suit and the class's affinity", () => {
    const c = { rank: "K", suit: "spades" as const };
    expect(classAlignment(c, { aligned: ["spades"], opposed: ["hearts"] })).toBe("aligned");
    expect(classAlignment({ rank: "K", suit: "hearts" }, { aligned: ["spades"], opposed: ["hearts"] })).toBe("opposed");
    expect(classAlignment(c, undefined)).toBe("neutral");
    expect(combine("aligned", "aligned")).toBe("aligned");
    expect(combine("aligned", "opposed")).toBe("neutral");
    expect(combine("opposed", "neutral")).toBe("opposed");
  });
});
