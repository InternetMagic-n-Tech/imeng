/*
 * Poker hand ranking, in code so the Dealer never has to judge a showdown. Variants: holdem (best five of two hole cards and the board),
 * omaha (exactly two of four hole cards and three of the board), stud5 (the five cards a player holds, no board).
 */

export type Variant = "holdem" | "omaha" | "stud5";
export const VARIANTS: Variant[] = ["holdem", "omaha", "stud5"];
export interface Card { rank: number; suit: "c" | "d" | "h" | "s" }

const RANKS: Record<string, number> = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, t: 10, ten: 10, j: 11, jack: 11, q: 12, queen: 12, k: 13, king: 13, a: 14, ace: 14 };
const SUITS: Record<string, Card["suit"]> = { c: "c", clubs: "c", club: "c", d: "d", diamonds: "d", diamond: "d", h: "h", hearts: "h", heart: "h", s: "s", spades: "s", spade: "s" };
export const CATEGORY = ["high card", "pair", "two pair", "three of a kind", "straight", "flush", "full house", "four of a kind", "straight flush"] as const;

/** "7h", "10s", "Td", "7 of hearts", "Ace of spades". */
export function parseCard(text: string): Card {
  const t = String(text).trim().toLowerCase();
  const m = /^(10|[2-9tjqka])\s*([cdhs])$/.exec(t) ?? /^([a-z0-9]+)\s+of\s+([a-z]+)$/.exec(t);
  const rank = m ? RANKS[m[1]] : undefined, suit = m ? SUITS[m[2]] : undefined;
  if (!rank || !suit) throw new Error(`not a card: ${text}`);
  return { rank, suit };
}
export const cardName = (c: Card): string => `${["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"][c.rank]}${c.suit}`;

/** A comparable score for exactly five cards: [category, ...tie-breaking ranks]. */
export function score5(cards: Card[]): number[] {
  if (cards.length !== 5) throw new Error("a hand is five cards");
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const uniq = [...new Set(ranks)];
  let high = 0;
  if (uniq.length === 5) { if (ranks[0] - ranks[4] === 4) high = ranks[0]; else if (ranks.join() === "14,5,4,3,2") high = 5; }
  const counts = new Map<number, number>(); for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join("");
  const by = groups.map((g) => g[0]);
  if (high && flush) return [8, high];
  if (shape === "41") return [7, ...by];
  if (shape === "32") return [6, ...by];
  if (flush) return [5, ...ranks];
  if (high) return [4, high];
  if (shape === "311") return [3, ...by];
  if (shape === "221") return [2, ...by];
  if (shape === "2111") return [1, ...by];
  return [0, ...ranks];
}

export const compareScores = (a: number[], b: number[]): number => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

function* choose<T>(items: T[], k: number, from = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === k) { yield [...picked]; return; }
  for (let i = from; i <= items.length - (k - picked.length); i++) { picked.push(items[i]); yield* choose(items, k, i + 1, picked); picked.pop(); }
}

/** The best five-card hand a player can make under the variant's rule. */
export function bestHand(variant: Variant, hole: Card[], board: Card[]): { score: number[]; cards: Card[]; name: string } {
  let pool: Card[][];
  if (variant === "omaha") {
    if (hole.length !== 4 || board.length < 3) throw new Error("omaha needs four hole cards and at least three on the board");
    pool = []; for (const h of choose(hole, 2)) for (const b of choose(board, 3)) pool.push([...h, ...b]);
  } else if (variant === "stud5") {
    if (hole.length !== 5) throw new Error("five card stud needs five cards per player");
    pool = [hole];
  } else {
    const all = [...hole, ...board];
    if (hole.length !== 2 || all.length < 5) throw new Error("holdem needs two hole cards and at least three on the board");
    pool = [...choose(all, 5)];
  }
  let best = pool[0], bestScore = score5(best);
  for (const h of pool.slice(1)) { const s = score5(h); if (compareScores(s, bestScore) > 0) { best = h; bestScore = s; } }
  return { score: bestScore, cards: best, name: CATEGORY[bestScore[0]] };
}

export interface Seat { id: string; hole: string[] }
export interface Ranked { id: string; name: string; cards: string[]; score: number[]; winner: boolean; place: number }

/** Rank every seat; `winner` is set for all who tie for best. Duplicate cards anywhere are an error (the deal is wrong). */
export function showdown(variant: Variant, board: string[], seats: Seat[]): Ranked[] {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant: ${variant}`);
  if (!seats.length) throw new Error("no hands to rank");
  const seen = new Set<string>();
  for (const t of [...board, ...seats.flatMap((s) => s.hole)]) { const k = cardName(parseCard(t)); if (seen.has(k)) throw new Error(`card dealt twice: ${t}`); seen.add(k); }
  const b = board.map(parseCard);
  const rows = seats.map((s) => { const r = bestHand(variant, s.hole.map(parseCard), b); return { id: s.id, name: r.name, cards: r.cards.map(cardName), score: r.score }; });
  const top = rows.reduce((m, r) => (compareScores(r.score, m) > 0 ? r.score : m), rows[0].score);
  const sorted = [...rows].sort((x, y) => compareScores(y.score, x.score));
  return rows.map((r) => ({ ...r, winner: compareScores(r.score, top) === 0, place: 1 + sorted.filter((o) => compareScores(o.score, r.score) > 0).length }));
}
