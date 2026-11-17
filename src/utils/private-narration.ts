import { PHASES } from "./config.js";
import { evalCondition } from "./conditions.js";
import { phaseOf } from "./phases.js";
import { holds } from "./pay.js";
import type { Condition } from "./conditions.js";
import type { GameState, Session } from "./types.js";

/**
 * `phases.<name>.private_narration: {line, recipients: "escrow", unless}`: while the game is in that phase the table reads only the fixed `line`; the narrator's reply is held back
 * and handed to the two people named by the escrow (payer and payee, remembered in the server's `game.private_to` for the phase). `when` (a condition) limits it to those moments, `unless` (e.g. game.dance_public >= 1) turns it off.
 * Open WebUI shows the held text with their next reply; an interface that pushes (Discord) delivers it at once. Fails open to nothing private: with nobody to send it to, the table reads it.
 */
export function privateNarration(session: Session, state: GameState): { line: string; to: string[] } | null {
  const def = PHASES?.[phaseOf(state)]?.privateNarration;
  if (!def) { delete state.game.private_to; return null; }
  if (def.when !== undefined && !evalCondition(def.when as Condition, state)) { delete state.game.private_to; return null; } // not that moment: forget the pair
  if (def.unless !== undefined && evalCondition(def.unless as Condition, state)) return null;
  let actors = Array.isArray(state.game.private_to) ? (state.game.private_to as string[]) : [];
  if (!actors.length) {
    actors = [...new Set(holds(state).flatMap((h) => [h.from, h.to]))];
    if (actors.length) state.game.private_to = actors;
  }
  const players = Object.values(session.room?.players ?? {});
  const to = actors.flatMap((a) => players.filter((p) => p.actor === a).map((p) => p.userId));
  return to.length ? { line: def.line, to } : null;
}
