import crypto from "node:crypto";
import { bestHand, compareScores, parseCard, VARIANTS, type Card, type Variant } from "../tools/poker-eval.js";
import { SENSE } from "./config.js";
import type { GameState } from "./types.js";

/**
 * Player intelligence for betting "server" (config.json `sense`). Every play by every seat is weighed against the odds, by code:
 *  - game.sense[id] = {recent}: a string of "g" (the play fits the odds), "b" (against them by more than `margin`) over the last `window` decisions; weak raises are neutral ("-", a bluff).
 *  - game.seen[viewer][id] = {bluffs, honest}: what each seat dealt into a hand was shown at its showdown: did `id` raise with a weak hand (a caught bluff) or a strong one.
 * Only code writes these. The narrator is told a short read (senseBlock) and NPCs may weigh it (poker-npc.ts). Win chance is sampled from the cards nobody can see; `samples` is capped by EQUITY_MAX_SAMPLES.
 */
type G = Record<string, any>;
const FULL: Card[] = (["c", "d", "h", "s"] as const).flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ rank: i + 2, suit })));
const key = (c: Card): string => `${c.rank}${c.suit}`;
export type Roll = () => number;
const rngDefault: Roll = () => crypto.randomInt(0, 1_000_000) / 1_000_000;
export const maxSamples = (): number => Math.max(20, Math.floor(Number(process.env.EQUITY_MAX_SAMPLES)) || 500);

/** Chance (0 to 1) that `hole` wins against `opponents` random hands, sampling the rest of the board; ties share. 0.5 when the deck cannot cover it. */
export function equity(variant: Variant, hole: string[], board: string[], opponents: number, samples: number, rng: Roll = rngDefault): number {
  const mine = hole.map(parseCard), known = [...mine, ...board.map(parseCard)], seen = new Set(known.map(key));
  const rest = FULL.filter((c) => !seen.has(key(c))), boardNeed = variant === "stud5" ? 0 : Math.max(0, 5 - board.length), opp = Math.max(1, opponents);
  const need = boardNeed + opp * mine.length, n = Math.min(maxSamples(), Math.max(1, Math.floor(samples)));
  if (rest.length < need || !mine.length) return 0.5;
  let total = 0;
  for (let t = 0; t < n; t++) {
    const pool = rest.slice();
    for (let i = 0; i < need; i++) { const j = i + Math.floor(rng() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const fullBoard = [...board.map(parseCard), ...pool.slice(0, boardNeed)];
    const me = bestHand(variant, mine, fullBoard).score;
    let best = 0, ties = 0;
    for (let o = 0; o < opp; o++) {
      const oh = pool.slice(boardNeed + o * mine.length, boardNeed + (o + 1) * mine.length), c = compareScores(me, bestHand(variant, oh, fullBoard).score);
      if (c < 0) { best = -1; break; }
      if (c === 0) ties++;
    }
    if (best === 0) total += 1 / (ties + 1);
  }
  return total / n;
}

export type Verdict = "good" | "bad" | "bluff";

/** Does a play fit the odds? fold: bad when it gave up a hand worth the price (or a free check); call: bad when the hand was worth less than the price; raise: a weak hand is a bluff (not scored), else as a call; check: always fits. */
export function verdict(action: string, eq: number, need: number, pot: number, margin: number, bluffBelow: number): Verdict {
  const price = need > 0 ? need / (pot + need) : 0;
  switch (action) {
    case "fold": return need === 0 || eq >= price + margin ? "bad" : "good";
    case "call": return eq < price - margin ? "bad" : "good";
    case "raise": case "allin": return eq < bluffBelow ? "bluff" : need > 0 && eq < price - margin ? "bad" : "good";
    default: return "good";
  }
}

/** Weigh the play `id` is about to make (call before act() changes the state) and remember it; returns the verdict. Does nothing without `sense` in config.json. */
export function judgePlay(s: GameState, id: string, action: string, opponents: number, rng: Roll = rngDefault): Verdict | null {
  if (!SENSE) return null;
  const g = s.game as G, a = s.actors[id] as G, hole = Array.isArray(a?.hole) ? (a.hole as string[]) : [];
  if (!hole.length) return null;
  const board = (((s.actors.table as G)?.board ?? []) as string[]), pot = Number((s.actors.table as G)?.pot) || 0;
  const need = Math.max(0, (Number(g.bet_level) || 0) - (Number(a.bet) || 0)), v0 = String(g.variant ?? "holdem") as Variant, variant = VARIANTS.includes(v0) ? v0 : "holdem";
  let eq: number;
  try { eq = equity(variant, hole, board, opponents, SENSE.samples, rng); } catch { return null; }
  const v = verdict(action, eq, need, pot, SENSE.margin, SENSE.bluffBelow);
  const all = (g.sense ??= {}) as Record<string, { recent: string }>, me = (all[id] ??= { recent: "" });
  me.recent = (me.recent + (v === "good" ? "g" : v === "bad" ? "b" : "-")).slice(-SENSE.window);
  if (action === "raise" || action === "allin") { const k = v === "bluff" ? "weak_raisers" : "strong_raisers", l = (g[k] ??= []) as string[]; if (!l.includes(id)) l.push(id); }
  return v;
}

/** At a showdown every seat dealt into the hand sees who raised weak (a caught bluff) and who raised strong. */
export function recordShowdown(s: GameState, viewers: string[], shown: string[]): void {
  if (!SENSE) return;
  const g = s.game as G, weak = (g.weak_raisers ?? []) as string[], strong = (g.strong_raisers ?? []) as string[];
  const seen = (g.seen ??= {}) as Record<string, Record<string, { bluffs: number; honest: number }>>;
  for (const id of shown) {
    const bluff = weak.includes(id), honest = !bluff && strong.includes(id);
    if (!bluff && !honest) continue;
    for (const v of viewers) { if (v === id) continue; const e = ((seen[v] ??= {})[id] ??= { bluffs: 0, honest: 0 }); if (bluff) e.bluffs++; else e.honest++; }
  }
}

/** Share of judged decisions that fit the odds, or null until `min` have been judged. */
export function senseRatio(s: GameState, id: string, min = 5): number | null {
  const r = String(((s.game as G).sense?.[id] as { recent?: string } | undefined)?.recent ?? ""), g = (r.match(/g/g) ?? []).length, b = (r.match(/b/g) ?? []).length;
  return g + b >= min ? g / (g + b) : null;
}

/** How often `target` has been caught bluffing, as seen by `viewer` (null until it has been shown twice). */
export function bluffRate(s: GameState, viewer: string, target: string | null): number | null {
  const e = target ? (((s.game as G).seen?.[viewer] ?? {}) as Record<string, { bluffs: number; honest: number }>)[target] : undefined;
  return e && e.bluffs + e.honest >= 2 ? e.bluffs / (e.bluffs + e.honest) : null;
}

/** The narrator's short read on how the table has played (empty when nothing stands out). */
export function senseBlock(s: GameState): string {
  if (!SENSE) return "";
  const g = s.game as G, lines: string[] = [];
  for (const [id, a] of Object.entries(s.actors)) {
    if (id === "table") continue;
    const nm = String((a as G)?.name ?? id), r = String(g.sense?.[id]?.recent ?? ""), bad = (r.match(/b/g) ?? []).length, n = (r.match(/[gb]/g) ?? []).length;
    if (n >= 5 && bad / n >= 0.5) lines.push(SENSE.texts.against.replace(/\{name\}/g, nm).replace(/\{bad\}/g, String(bad)).replace(/\{n\}/g, String(n)));
    const caught = Math.max(0, ...Object.values((g.seen ?? {}) as Record<string, Record<string, { bluffs: number }>>).map((m) => m?.[id]?.bluffs ?? 0));
    if (caught >= 2) lines.push(SENSE.texts.caught.replace(/\{name\}/g, nm).replace(/\{n\}/g, String(caught)));
  }
  return lines.length ? `\n\n## READ ON THE PLAYERS (written by the server from the cards and the odds)\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}
