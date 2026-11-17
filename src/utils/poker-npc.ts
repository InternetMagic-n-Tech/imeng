import crypto from "node:crypto";
import { bestHand, parseCard, VARIANTS, type Variant } from "../tools/poker-eval.js";
import { bluffRate, senseRatio } from "./poker-sense.js";
import type { GameState } from "./types.js";

/**
 * How a server-run seat plays (betting "server"). `game.npc_aggression` (0 to 1, default 0): 0 keeps the old fixed rule (check, call a small price, fold a big one);
 * above 0 an NPC weighs its hand, the price and what the bettor has done at this table (game.npc_stats: acts and raises per seat, written by act()), and may raise or bluff. Dice are the server's.
 */
type G = Record<string, any>;
type Stats = Record<string, { acts: number; raises: number }>;
export type Roll = () => number;
export const serverRoll: Roll = () => crypto.randomInt(0, 1_000_000) / 1_000_000;
const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

export const aggression = (s: GameState): number => clamp(Number((s.game as G).npc_aggression) || 0);

/** Hand strength 0 to 1: the best made hand once there is a board, the hole cards before. */
export function strength(s: GameState, id: string): number {
  const a = s.actors[id] as G, hole = (Array.isArray(a?.hole) ? a.hole : []) as string[], board = ((s.actors.table as G)?.board ?? []) as string[];
  const v = String((s.game as G).variant ?? "holdem") as Variant, variant = VARIANTS.includes(v) ? v : "holdem";
  try {
    if (board.length >= 3 || variant === "stud5") {
      const { score } = bestHand(variant, hole.map(parseCard), board.map(parseCard));
      return clamp([0.1, 0.4, 0.65, 0.75, 0.85, 0.88, 0.95, 1, 1][score[0]] + (score[0] <= 1 ? (score[1] ?? 0) / 14 * 0.15 : 0));
    }
    const cs = hole.map(parseCard).sort((x, y) => y.rank - x.rank), hi = cs[0].rank, lo = cs[1].rank;
    return clamp((hi + lo) / 28 * 0.6 + (hi === lo ? 0.3 : 0) + (cs[0].suit === cs[1].suit ? 0.05 : 0) + (hi - lo <= 2 ? 0.05 : 0));
  } catch { return 0.3; }
}

/** How often this seat raises when it acts (0 to 1); a stranger is 0.25. */
const raiseRate = (s: GameState, id: string | null): number => { const st = ((s.game as G).npc_stats ?? {}) as Stats, x = id ? st[id] : undefined; return x && x.acts >= 4 ? x.raises / x.acts : 0.25; };

/** The NPC's action: check, call, raise or fold. */
export function npcAction(s: GameState, id: string, roll: Roll = serverRoll): "check" | "call" | "raise" | "fold" {
  const g = s.game as G, a = s.actors[id] as G, ag = aggression(s), chips = Number(a.chips) || 0;
  const need = Math.max(0, (Number(g.bet_level) || 0) - (Number(a.bet) || 0)), pot = Number((s.actors.table as G)?.pot) || 0;
  if (!ag) return need === 0 ? "check" : need <= chips / 4 ? "call" : "fold";
  const str = strength(s, id), rate = raiseRate(s, g.last_raiser ?? null);
  if (need === 0) {
    if (str >= 0.7 - 0.2 * ag && roll() < ag * (0.3 + str)) return "raise";
    if (str < 0.3 && roll() < 0.1 * ag * (1 - rate)) return "raise"; // a bluff, likelier when the table has been passive
    return "check";
  }
  const br = bluffRate(s, id, g.last_raiser ?? null), sr = senseRatio(s, String(g.last_raiser ?? ""));
  // a habitual raiser is called lighter, a rare one respected; so is one this seat has seen caught bluffing, or whose plays have not made sense (game.sense, game.seen)
  const price = need / (pot + need), eff = str + (rate - 0.25) * 0.4 * ag + (br === null ? 0 : (br - 0.25) * 0.5 * ag) + (sr === null ? 0 : (0.5 - sr) * 0.3 * ag);
  if (need > chips / 2 && eff < 0.8) return "fold";
  if (eff >= 0.8 && roll() < ag * 0.6) return "raise";
  return eff >= 0.2 + price * 1.1 ? "call" : "fold";
}
