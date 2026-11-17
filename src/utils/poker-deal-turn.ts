import { newDeal, ritualStep, dealHole, dealBoard } from "./poker-deal.js";
import { VARIANTS, type Variant } from "../tools/poker-eval.js";
import { dealtIn } from "./poker-seats.js";
import { SHUFFLE } from "./config.js";
import type { GameState } from "./types.js";

/**
 * `deal: "server"` (config.json): the server deals, never the narrator. Called when the phase changes: entering `preflop` shuffles a fresh deck and deals every seated player their hole cards
 * and sets the five community cards face down in `actors.table.reserve`; entering flop, turn or river moves them to `actors.table.board`. Returns change operations (not a state).
 * A seat is any actor with chips (at least `game.min_to_play`) and not "sitting out" (the table itself has no chips field). The deck is built fresh each hand, so nothing private has to be kept between turns.
 */
const tableId = (s: GameState): string | undefined => (s.actors.table ? "table" : undefined);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function dealOps(state: GameState, to: string): unknown[] {
  const t = tableId(state);
  if (!t) return [];
  const table = state.actors[t] as Record<string, unknown>;
  if (to === "preflop") {
    if (SHUFFLE?.required === "each_hand" && !Number(state.game.shuffled)) return []; // blocked until someone shuffles (the phase gate normally stops it first)
    const v = String(state.game.variant ?? "holdem") as Variant;
    const variant = VARIANTS.includes(v) ? v : "holdem";
    const seats = Object.keys(state.actors).filter((id) => id !== t && dealtIn(state, id));
    const out: unknown[] = Object.keys(state.actors).filter((id) => id !== t && !seats.includes(id) && Array.isArray((state.actors[id] as any)?.hole) && (state.actors[id] as any).hole.length).map((id) => ({ op: "set", path: `actors.${id}.hole`, value: [] }));
    if (seats.length < 2) return [...out, ...(seats.length ? [] : [])];
    const d = newDeal(variant);
    ritualStep(d, ""); // the dealer (the server) shuffles
    if (!dealHole(d, seats).ok) return out;
    const dealt = seats.flatMap((id) => d.hole[id]);
    let reserve: string[] = [];
    if (variant !== "stud5") { dealBoard(d, "flop"); dealBoard(d, "turn"); dealBoard(d, "river"); reserve = d.board; }
    for (const id of seats) out.push({ op: "set", path: `actors.${id}.hole`, value: d.hole[id] });
    out.push({ op: "set", path: "game.shuffled", value: 0 }, { op: "set", path: "game.shuffle_step", value: 0 }, { op: "set", path: `actors.${t}.reserve`, value: reserve }, { op: "set", path: `actors.${t}.board`, value: [] }, { op: "set", path: `actors.${t}.dealt`, value: dealt });
    return out;
  }
  const n = to === "flop" ? 3 : to === "turn" || to === "river" ? 1 : 0;
  if (!n) return [];
  const reserve = asList(table.reserve), board = asList(table.board);
  const want = to === "flop" ? 0 : to === "turn" ? 3 : 4;
  if (board.length !== want || reserve.length < n) return []; // already shown, or nothing left to show
  const shown = reserve.slice(0, n);
  return [
    { op: "set", path: `actors.${t}.board`, value: [...board, ...shown] },
    { op: "set", path: `actors.${t}.reserve`, value: reserve.slice(n) },
    { op: "set", path: `actors.${t}.dealt`, value: [...asList(table.dealt), ...shown] },
  ];
}
