import { BAN, HANDS } from "./config.js";
import { ban } from "./bans.js";
import { announce } from "./announce.js";
import type { PlayerRef } from "./multiplayer.js";
import { bestHand, compareScores, parseCard as evalCard, cardName, type Card } from "../tools/poker-eval.js";
import type { GameState, Session } from "./types.js";

/**
 * Peeking at hands (config.json `ban` + `private_hands`). Everything here is decided by code from the real cards in the state:
 * - `/peek <name>` (private chat only) shows another player's cards to the peeker alone. Allowed once per hand, at the start of the hand (`ban.peek_phases`, default preflop), at one
 *   person: the owner (the dealer) is told, privately, on their next reply. Anything else is a violation: a ban of `ban.hours`, and the owner is told that too. Looking at your own
 *   cards is never a peek.
 * - Saying another player's whole hand in a shared chat (before the showdown) is refused, never forwarded, and bans the sender for `ban.reveal_hours` (default 168 = one week), but
 *   only when it is RIGHT: a wrong guess costs nothing. A message that repeats a card someone peeked at is refused too, without a ban.
 */
const TEXTS: Record<string, string> = {
  usage: "Use /peek <name>.", shared: "Do that in your private chat with the dealer.", unknown: "I don't know a player called \"{who}\".", self: "Your own cards: {cards}. (Looking at your own cards is never a peek.)",
  shown: "{name}'s cards: {cards}. The dealer has been told you looked.", none: "{name} has no cards right now.",
  caught: "You looked outside the start of the hand (or at a second person), so you are out of the game until {time}. The dealer has been told.",
  told_ok: "{who} looked at {name}'s cards at the start of hand {hand}.", told_bad: "{who} tried to look at {name}'s cards when they should not have, and was put out of the game until {time}.",
  guessed: "That is your second try at swaying the table about hidden cards in one hand, so you are out until {time}. It was not sent.",
  viewer_told: "You asked to see the hands, so you may not comment at the table in that hand. You are out until {time}. It was not sent.",
  odds_seated: "You are sitting at this table: seeing everyone's hands is only for people watching without a seat.", odds_none: "There are no hands to look at right now.", odds_head: "Hand {hand}, {phase}. Board: {board}.", odds_line: "{name}: {cards} ({pct}%)",
  blocked: "That would give away someone's cards, so it was not sent.",
  revealed: "You announced someone's hidden hand, so you are out of the game until {time}. It was not sent.",
};
const say = (k: string, v: Record<string, string> = {}): string => (TEXTS[k] ?? k).replace(/\{(\w+)\}/g, (_m, x: string) => v[x] ?? "");
const norm = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");
const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

const CARD = /\b(ace|king|queen|jack|two|three|four|five|six|seven|eight|nine|ten|10|[2-9]|[ajqk])\s*(?:of\s+)?(hearts?|diamonds?|clubs?|spades?|[hdcs])\b/gi;
const RANK: Record<string, string> = { ace: "A", king: "K", queen: "Q", jack: "J", ten: "T", "10": "T", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const key = (rank: string, suit: string): string => `${RANK[rank.toLowerCase()] ?? rank.toUpperCase()}${suit.toLowerCase()[0]}`;
/** Every card named in a text, as rank+suit keys like "Ah". */
export function cardsIn(text: string): Set<string> { const out = new Set<string>(); for (const m of text.matchAll(CARD)) out.add(key(m[1]!, m[2]!)); return out; }
const holeOf = (state: GameState, actor: string): string[] => {
  const h = (state.actors[actor] as Record<string, unknown> | undefined)?.[HANDS?.field ?? "hole"];
  return Array.isArray(h) ? [...cardsIn(h.map(String).join(" . "))] : [];
};

/** A player's whole hand said in a text that is for others to read. Null when it is fine. */
export function revealCheck(session: Session, sender: PlayerRef, text: string): { kind: "whole" | "peeked" } | null {
  if (!HANDS || !BAN || !session.room) return null;
  const state = session.snapshots.at(-1)!, phase = String(state.game.phase ?? "");
  if (phase === "showdown") return null; // hands are shown then
  const said = cardsIn(text);
  if (!said.size) return null;
  const me = session.room.players[sender.userId];
  const peeked = session.peeks?.[sender.userId];
  for (const p of Object.values(session.room.players)) {
    if (p.userId === sender.userId || (me && p.actor === me.actor)) continue;
    const hand = holeOf(state, p.actor);
    if (hand.length >= 2 && hand.every((c) => said.has(c))) return { kind: "whole" };
    if (peeked && peeked.target === p.userId && peeked.hand === Number(state.game.hand) && hand.some((c) => said.has(c))) return { kind: "peeked" };
  }
  return null;
}

/** Apply the check: a whole correct hand bans for a week and nothing is forwarded. Returns the reply to give instead, or null to let the message through. */
export interface Guarded { text: string; kick?: { userId: string; until: number } }
export async function guardReveal(session: Session, table: string, sender: PlayerRef, text: string, now = Date.now()): Promise<Guarded | null> {
  const r = revealCheck(session, sender, text);
  if (!r) return wrongGuess(session, table, sender, text, now);
  if (r.kind === "peeked") return (await strike(session, table, sender, now)) ?? { text: say("blocked") };
  const until = await ban(session, table, sender.userId, BAN!.revealHours, "announced a correct hidden hand", now);
  return { text: say("revealed", { time: when(until) }), kick: { userId: sender.userId, until } };
}

/**
 * One message trying to sway the table about hidden cards is heckling, and heckling is fine; a second in the same hand is trying to ruin the hand, and that is not: out for
 * `ban.wrong_guess_hours` (24), the message not sent. Counts per hand, and per person (a peeker repeating what they saw counts too).
 */
async function strike(session: Session, table: string, sender: PlayerRef, now: number): Promise<Guarded | null> {
  if (!BAN) return null;
  const hand = Number(session.snapshots.at(-1)!.game.hand) || 0;
  const g = (session.guesses ??= {});
  const cur = g[sender.userId]?.hand === hand ? g[sender.userId]!.n : 0;
  g[sender.userId] = { hand, n: cur + 1 };
  if (cur + 1 < 2) return null;
  g[sender.userId] = { hand, n: 0 };
  const until = await ban(session, table, sender.userId, BAN.wrongGuessHours, "tried to sway the table about hidden hands twice in one hand", now);
  return { text: say("guessed", { time: when(until) }), kick: { userId: sender.userId, until } };
}

async function wrongGuess(session: Session, table: string, sender: PlayerRef, text: string, now: number): Promise<Guarded | null> {
  if (!HANDS || !BAN || !session.room) return null;
  const state = session.snapshots.at(-1)!;
  if (String(state.game.phase ?? "") === "showdown" || cardsIn(text).size < 1) return null;
  const lower = norm(text);
  const named = Object.values(session.room.players).some((p) => p.userId !== sender.userId && new RegExp(`\\b${norm(p.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
  if (!named) return null; // not about anyone's hand
  return strike(session, table, sender, now); // the first in a hand goes through
}

/** People who looked at the hands without a seat (see oddsCommand): they may watch, not join, and may not say what they saw. */
export async function guardViewer(session: Session, table: string, sender: PlayerRef, text: string, now = Date.now()): Promise<Guarded | null> {
  const hand = session.viewers?.[sender.userId];
  if (hand === undefined || !BAN || !HANDS || session.room?.players[sender.userId]) return null;
  const state = session.snapshots.at(-1)!;
  if (hand !== (Number(state.game.hand) || 0)) { delete session.viewers![sender.userId]; return null; } // that hand is over
  const until = await ban(session, table, sender.userId, BAN.wrongGuessHours, "commented at the table after asking to see the hands", now); // anything they say is influence
  return { text: say("viewer_told", { time: when(until) }), kick: { userId: sender.userId, until } };
}

export async function peekCommand(session: Session, table: string, who: PlayerRef, arg: string, isPrivate: boolean, now = Date.now()): Promise<string> {
  if (!HANDS || !BAN || !session.room) return "";
  if (!isPrivate) return say("shared");
  const name = arg.trim();
  if (!name) return say("usage");
  const state = session.snapshots.at(-1)!;
  const target = Object.values(session.room.players).find((p) => norm(p.name) === norm(name));
  if (!target) return say("unknown", { who: name });
  const field = HANDS.field;
  const cardsOf = (actor: string): string => { const h = (state.actors[actor] as Record<string, unknown> | undefined)?.[field]; return Array.isArray(h) ? h.map(String).join(", ") : ""; };
  if (target.userId === who.userId) { const c = cardsOf(target.actor); return c ? say("self", { cards: c }) : say("none", { name: "You" }); }
  const hand = Number(state.game.hand) || 0, phase = String(state.game.phase ?? "");
  const used = session.peeks?.[who.userId];
  const legit = BAN.peekPhases.includes(phase) && !(used && used.hand === hand);
  const owner = session.owner?.userId;
  if (!legit) {
    const until = await ban(session, table, who.userId, BAN.hours, "peeked outside the start of the hand", now);
    if (owner && owner !== who.userId) await announce(session, { kind: "peek_caught", from: who.userId, to: owner, text: say("told_bad", { who: who.name, name: target.name, time: when(until) }), at: now });
    return say("caught", { time: when(until) });
  }
  const c = cardsOf(target.actor);
  if (!c) return say("none", { name: target.name });
  (session.peeks ??= {})[who.userId] = { hand, target: target.userId };
  if (owner && owner !== who.userId) await announce(session, { kind: "peek", from: who.userId, to: owner, text: say("told_ok", { who: who.name, name: target.name, hand: String(hand) }), at: now });
  return say("shown", { name: target.name, cards: c });
}

const FULL: Card[] = (() => { const o: Card[] = []; for (const suit of ["c", "d", "h", "s"] as const) for (let rank = 2; rank <= 14; rank++) o.push({ rank, suit }); return o; })();

/** Every live hand and its chance to win (ties share), worked out by code over the cards still to come. Only for people watching without a seat. */
export function oddsCommand(session: Session, who: PlayerRef, rng: () => number = Math.random, runs = 1500): string {
  if (!HANDS || !BAN || !session.room) return "";
  if (session.room.players[who.userId]) return say("odds_seated");
  const field = HANDS.field;
  const state = session.snapshots.at(-1)!;
  const seats = Object.values(session.room.players).map((p) => ({ p, a: state.actors[p.actor] as Record<string, unknown> | undefined })).filter((x) => x.a && x.a.status !== "folded" && Array.isArray(x.a[field]) && (x.a[field] as unknown[]).length >= 2);
  const table = state.actors.table as Record<string, unknown> | undefined;
  const board = (Array.isArray(table?.board) ? table!.board as unknown[] : []).map((c) => { try { return evalCard(String(c)); } catch { return null; } }).filter((c): c is Card => !!c);
  if (seats.length < 2) return say("odds_none");
  const holes = seats.map((x) => (x.a![field] as unknown[]).flatMap((c) => { try { return [evalCard(String(c))]; } catch { return []; } }));
  const known = new Set([...board, ...holes.flat()].map(cardName));
  const rest = FULL.filter((c) => !known.has(cardName(c)));
  const variant = state.game.variant === "omaha" ? "omaha" : "holdem";
  const wins = seats.map(() => 0);
  for (let r = 0; r < runs; r++) {
    const deck = [...rest]; for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
    const full = [...board, ...deck.slice(0, 5 - board.length)];
    const scores = holes.map((h) => bestHand(variant, h, full).score);
    let best = scores[0]!; for (const s of scores) if (compareScores(s, best) > 0) best = s;
    const tied = scores.map((s, i) => (compareScores(s, best) === 0 ? i : -1)).filter((i) => i >= 0);
    for (const i of tied) wins[i]! += 1 / tied.length;
  }
  (session.viewers ??= {})[who.userId] = Number(state.game.hand) || 0;
  const lines = seats.map((x, i) => say("odds_line", { name: x.p.name, cards: holes[i]!.map(cardName).join(" "), pct: String(Math.round((wins[i]! / runs) * 1000) / 10) }));
  return [say("odds_head", { hand: String(state.game.hand ?? 0), phase: String(state.game.phase ?? ""), board: board.length ? board.map(cardName).join(" ") : "none yet" }), ...lines].join("\n");
}
