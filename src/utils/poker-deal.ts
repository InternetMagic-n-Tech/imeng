import crypto from "node:crypto";
import { cardName, type Card, type Variant } from "../tools/poker-eval.js";

/**
 * The server's own cards: a real 52-card deck that only the dealer shuffles and deals, never the narrator.
 * This module is pure: nothing here reads a session or a clock. `Deal` is what a table keeps privately; the narrator is only ever given the public part (the board).
 */
export interface Deal { variant: Variant; deck: string[]; hole: Record<string, string[]>; board: string[]; shuffled: boolean; ritual: string[]; done: string[] }

const SUITS: Card["suit"][] = ["c", "d", "h", "s"];
export const newDeck = (): string[] => SUITS.flatMap((suit) => Array.from({ length: 13 }, (_v, i) => cardName({ rank: i + 2, suit })));

/** Fisher-Yates with crypto randomness (`rng` only for tests). */
export function shuffle<T>(cards: T[], rng: (n: number) => number = (n) => crypto.randomInt(0, n)): T[] {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) { const j = rng(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const HOLE: Record<Variant, number> = { holdem: 2, omaha: 4, stud5: 5 };

export function newDeal(variant: Variant, ritual: string[] = []): Deal {
  return { variant, deck: newDeck(), hole: {}, board: [], shuffled: false, ritual: [...ritual], done: [] };
}

/** The shuffle ritual (imeng `shuffle.ritual`, for example ["riffle 7", "cut"]): each step is run by the shuffler as `/shuffle riffle 7`, in order. Code does the real randomising once the last step is done. */
export function ritualStep(d: Deal, step: string, rng?: (n: number) => number): { ok: boolean; text: string } {
  const want = d.ritual[d.done.length];
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
  if (!d.ritual.length) { d.deck = shuffle(d.deck, rng); d.shuffled = true; return { ok: true, text: "The deck is shuffled." }; }
  if (!want) return { ok: false, text: "The deck is already shuffled." };
  if (norm(step) !== norm(want)) return { ok: false, text: `Not that: the next step is "${want}".` };
  d.done.push(want);
  if (d.done.length < d.ritual.length) return { ok: true, text: `Done. Next: "${d.ritual[d.done.length]}".` };
  d.deck = shuffle(d.deck, rng); d.shuffled = true;
  return { ok: true, text: "The deck is shuffled." };
}

/** Deal to the seats (hole cards) in turn. Refuses an unshuffled deck (the game is blocked until the shuffle is done). */
export function dealHole(d: Deal, seats: string[]): { ok: boolean; text: string } {
  if (!d.shuffled) return { ok: false, text: "The deck has not been shuffled yet." };
  const n = HOLE[d.variant];
  if (d.deck.length < n * seats.length) return { ok: false, text: "Not enough cards left." };
  for (const s of seats) d.hole[s] = [];
  for (let r = 0; r < n; r++) for (const s of seats) d.hole[s].push(d.deck.shift()!);
  return { ok: true, text: "Dealt." };
}

/** Deal the board: flop (3), turn (1) or river (1), burning one card first, as at a real table. */
export function dealBoard(d: Deal, street: "flop" | "turn" | "river"): { ok: boolean; cards: string[]; text: string } {
  if (!d.shuffled) return { ok: false, cards: [], text: "The deck has not been shuffled yet." };
  if (d.variant === "stud5") return { ok: false, cards: [], text: "This variant has no board." };
  const want = street === "flop" ? 3 : 1;
  if ((street === "flop" && d.board.length !== 0) || (street === "turn" && d.board.length !== 3) || (street === "river" && d.board.length !== 4)) return { ok: false, cards: [], text: `Not the time for the ${street}.` };
  if (d.deck.length < want + 1) return { ok: false, cards: [], text: "Not enough cards left." };
  d.deck.shift(); // burn
  const cards = d.deck.splice(0, want);
  d.board.push(...cards);
  return { ok: true, cards, text: "Dealt." };
}
