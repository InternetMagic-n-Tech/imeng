/**
 * Decks for magic users (pure code, no model). A deck is a list of cards, top first. Drawing takes from the top; a played card goes back into the
 * BOTTOM HALF at a random place, so it cannot be drawn again soon and the same card is never held twice. The server rolls everything; a judge only
 * says whether the player's chosen play is allowed.
 */
export type Suit = "hearts" | "diamonds" | "clubs" | "spades";
export interface Card { rank: string; suit: Suit }
export const SUITS: Suit[] = ["hearts", "diamonds", "clubs", "spades"];
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const cardId = (c: Card): string => `${c.rank}${c.suit[0]}`;

export function freshDeck(rng: () => number = Math.random): Card[] {
  const d = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j]!, d[i]!]; }
  return d;
}

/** Draw `n` cards from the top that are not already in `held` (no duplicates in a hand). Returns the cards and the deck without them. */
export function draw(deck: Card[], n: number, held: Card[] = []): { cards: Card[]; deck: Card[] } {
  const have = new Set(held.map(cardId)), cards: Card[] = [], rest: Card[] = [];
  for (const c of deck) { if (cards.length < n && !have.has(cardId(c))) { cards.push(c); have.add(cardId(c)); } else rest.push(c); }
  return { cards, deck: rest };
}

/** Put cards back into the bottom half of the deck at random places. */
export function putBack(deck: Card[], cards: Card[], rng: () => number = Math.random): Card[] {
  const d = [...deck];
  for (const c of cards) {
    const half = Math.floor(d.length / 2);
    d.splice(half + Math.floor(rng() * (d.length - half + 1)), 0, c);
  }
  return d;
}

/** Card value multiplier: 2-4 half, 5-10 full, J-K one and a quarter, A one and a half. */
export function multiplier(c: Card): number {
  if (c.rank === "A") return 1.5;
  if (["J", "Q", "K"].includes(c.rank)) return 1.25;
  return Number(c.rank) <= 4 ? 0.5 : 1;
}

/** Suit alignment changes how well a spell works (effectiveness only, never whether it can be cast). */
export type Alignment = "aligned" | "neutral" | "opposed";
export function effectiveness(c: Card, alignment: Alignment): number {
  return multiplier(c) * (alignment === "aligned" ? 1.25 : alignment === "opposed" ? 0.75 : 1);
}

/** One draw for a round: the card, its multiplier, and the deck with the card put back in the bottom half. */
export function drawOne(deck: Card[] | undefined, rng: () => number = Math.random): { card: Card; deck: Card[] } {
  const d = deck && deck.length >= 2 ? deck : freshDeck(rng);
  const { cards, deck: rest } = draw(d, 1);
  return { card: cards[0]!, deck: putBack(rest, cards, rng) };
}
export const cardName = (c: Card): string => `${c.rank} of ${c.suit}`;

const RANK_WORDS: Record<string, string> = { ace: "A", king: "K", queen: "Q", jack: "J", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
/** The first card a text names ("7 of spades", "queen of hearts", "10d", "ace spades"), or null. */
export function parseCard(text: string): Card | null {
  const t = text.toLowerCase();
  const suit = (s: string): Suit | null => SUITS.find((x) => x === s || x === s + "s" || x[0] === s) ?? null;
  const m = /\b(ace|king|queen|jack|two|three|four|five|six|seven|eight|nine|ten|10|[2-9]|[ajqk])\s*(?:of\s+)?(hearts?|diamonds?|clubs?|spades?|[hdcs])\b/.exec(t);
  if (!m) return null;
  const rank = RANK_WORDS[m[1]!] ?? m[1]!.toUpperCase();
  const s = suit(m[2]!);
  return s && RANKS.includes(rank) ? { rank, suit: s } : null;
}

/** Deal a hand of `size` from the top (no duplicates). */
export function deal(deck: Card[], size: number, held: Card[] = []): { hand: Card[]; deck: Card[] } {
  const r = draw(deck.length >= size + held.length ? deck : freshDeck(), size - held.length, held);
  return { hand: [...held, ...r.cards], deck: r.deck };
}

/** Play a named card from a hand: it goes back into the bottom half and one replacement is dealt. null when the card is not in the hand. */
export function play(deck: Card[], hand: Card[], card: Card, rng: () => number = Math.random): { played: Card; hand: Card[]; deck: Card[] } | null {
  const i = hand.findIndex((c) => cardId(c) === cardId(card));
  if (i < 0) return null;
  const played = hand[i]!, rest = hand.filter((_, j) => j !== i);
  const back = putBack(deck, [played], rng);
  const d = deal(back, rest.length + 1, rest);
  return { played, hand: d.hand, deck: d.deck };
}

/** The hand rules for one round of the deck phase. `lines` are the people who spoke (id, name, words). Returns what the narrator is told; mutates `store`. */
const RED = new Set<Suit>(["hearts", "diamonds"]);
/** A card's suit against a spell's suit: the same suit is aligned, the same colour neutral, the other colour opposed. */
export function alignmentOf(card: Card, spellSuit: string | undefined): Alignment {
  const s = SUITS.find((x) => x === spellSuit);
  if (!s) return "neutral";
  return card.suit === s ? "aligned" : RED.has(card.suit) === RED.has(s) ? "neutral" : "opposed";
}

export function handsRound(store: { cards: Card[]; hands?: Record<string, Card[]> }, lines: { id: string; name: string; text: string }[], size: number, note: string, rng: () => number = Math.random, align: (id: string, card: Card) => Alignment = () => "neutral"): string {
  const hands = (store.hands ??= {});
  const out: string[] = [];
  for (const l of lines) {
    let hand = hands[l.id];
    if (!hand || hand.length < size) { const d = deal(store.cards.length >= size ? store.cards : freshDeck(rng), size, hand ?? []); hand = hands[l.id] = d.hand; store.cards = d.deck; }
    const named = parseCard(l.text);
    const r = named ? play(store.cards, hand, named, rng) : null;
    if (r) { hands[l.id] = r.hand; store.cards = r.deck; const al = align(l.id, r.played); const eff = Math.round(effectiveness(r.played, al) * 100) / 100; out.push(`${l.name} PLAYS ${cardName(r.played)}, strength x${eff}${al === "neutral" ? "" : ` (${al} by suit)`}. ${note} Their new hand: ${r.hand.map(cardName).join(", ")}.`); }
    else out.push(`${l.name} has not played a card yet${named ? ` (${cardName(named)} is not in their hand)` : ""}. Show them their hand: ${hand.map(cardName).join(", ")}. Ask which card they play; do not resolve the attempt until they name one from the hand.`);
  }
  return out.length ? `\n\n## CARDS (dealt and checked by the server; do not change them)\n${out.join("\n")}` : "";
}

/** Two alignments together: aligned counts +1, opposed -1, neutral 0; the sum decides (so aligned with the spell but opposed to the class is neutral). */
export function combine(...a: Alignment[]): Alignment {
  const n = a.reduce((x, v) => x + (v === "aligned" ? 1 : v === "opposed" ? -1 : 0), 0);
  return n > 0 ? "aligned" : n < 0 ? "opposed" : "neutral";
}
/** A class's own suit affinities (`{aligned: [suits], opposed: [suits]}`): a card of an aligned suit favours the class, of an opposed suit works against it. */
export function classAlignment(card: Card, aff: { aligned?: string[]; opposed?: string[] } | undefined): Alignment {
  if (!aff) return "neutral";
  return aff.aligned?.includes(card.suit) ? "aligned" : aff.opposed?.includes(card.suit) ? "opposed" : "neutral";
}
