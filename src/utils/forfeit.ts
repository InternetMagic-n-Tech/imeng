import crypto from "node:crypto";
import { FORFEIT } from "./config.js";
import { evalCondition, type Condition } from "./conditions.js";
import { applyOps } from "./state.js";
import type { GameState, Session } from "./types.js";

/**
 * A forfeit the server deals (config.json `forfeit`): after a narrated round, with `chance`, one real player who meets `if` must send a picture (an attachment) within `rounds` narrated rounds.
 * Code picks the person, notices the picture and applies `penalty` when the time runs out; the narrator only dramatises (game.forfeit is server-owned). The picture itself is never read by any
 * model: with a database or bucket it is kept and the message carries `[image:<id>]` (utils/attachments.ts); without one it travels like any attachment, so a game that asks for faces should have one.
 */
type G = Record<string, any>;
const fill = (t: string, name: string): string => t.replace(/\{name\}/g, name);
const nameOf = (s: GameState, id: string): string => String((s.actors[id] as G | undefined)?.name ?? id);

/** True when a message's content carries a picture (an image part, or a kept `[image:<id>]` placeholder). */
export function hasImage(content: unknown): boolean {
  if (typeof content === "string") return /\[image:[A-Za-z0-9_-]+\]/.test(content);
  return Array.isArray(content) && content.some((p: any) => p?.type === "image_url" || (typeof p?.text === "string" && /\[image:[A-Za-z0-9_-]+\]/.test(p.text)));
}

const PLAYER_ROLES = ["user", "other_player"];
const realPlayers = (s: GameState): string[] => Object.entries(s.actors).filter(([id, a]) => id !== "table" && PLAYER_ROLES.includes(String((a as G)?.controlled_by)) && !(Array.isArray((s.game as G).exited_game) && (s.game as G).exited_game.some((e: any) => e?.id === id))).map(([id]) => id);

/** After a narrated round: count the pending forfeit down (a miss applies the penalty), or roll a new one. */
export function rollForfeit(session: Session, state: GameState, round: number, rng: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000): GameState {
  if (!FORFEIT) return state;
  const F = FORFEIT, g = state.game as G, cur = g.forfeit as { actor: string; left: number } | undefined, said: string[] = [];
  let out = state;
  if (cur) {
    if (cur.left > 1) { g.forfeit = { ...cur, left: cur.left - 1 }; return out; }
    delete g.forfeit;
    if (F.penalty && out.actors[cur.actor]) { const r = applyOps(out, [{ op: "inc", path: `actors.${cur.actor}.${F.penalty.field}`, value: F.penalty.add }]); out = r.state; }
    said.push(fill(F.missed, nameOf(out, cur.actor)));
  } else if (rng() < F.chance) {
    const pool = realPlayers(out).filter((id) => !F.if || evalCondition(F.if as Condition, out, out.actors[id] as any));
    if (pool.length) { const id = pool[Math.floor(rng() * pool.length) % pool.length]; (out.game as G).forfeit = { actor: id, left: F.rounds }; said.push(fill(F.text, nameOf(out, id))); }
  }
  for (const t of said) (session.pendingEvents ??= []).push({ round, text: t });
  return out;
}

/** The person whose forfeit it is sent a picture: clears it. Returns the line for the narrator, or "". */
export function answerForfeit(state: GameState, actor: string): string {
  const g = state.game as G, cur = g.forfeit as { actor: string } | undefined;
  if (!FORFEIT || !cur || cur.actor !== actor) return "";
  delete g.forfeit;
  return fill(FORFEIT.done, nameOf(state, actor));
}
