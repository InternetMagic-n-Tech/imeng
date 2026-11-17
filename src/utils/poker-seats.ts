import type { GameState } from "./types.js";

/**
 * Who is dealt in. `game.min_to_play` (state, so a table can agree it at registration): absent or 0 = anyone with chips (old behaviour), a number, or "big_blind"
 * (the current big blind). A player with fewer chips stays at the table but is not dealt in. Pure.
 */
export function minToPlay(s: GameState): number {
  const v = s.game.min_to_play;
  if (v === "big_blind") return Math.max(2, Number(s.game.big_blind) || 10); // same floor and default as blinds() in poker-bet.ts
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const dealtIn = (s: GameState, id: string): boolean => {
  const a = s.actors[id] as { chips?: unknown; status?: unknown } | undefined;
  const chips = Number(a?.chips);
  return !!a && id !== "table" && Number.isFinite(chips) && chips > 0 && a.status !== "sitting out" && chips >= minToPlay(s);
};
