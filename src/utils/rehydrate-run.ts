import { USER_ID } from "./config.js";
import { dbg } from "./debug.js";
import { stateDb } from "./db-state.js";
import { REHYDRATE } from "./rehydrate-config.js";
import { ELIGIBILITY } from "./eligibility-config.js";
import { applyRules } from "./eligibility.js";
import { pull, push } from "./rehydrate.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

/** The engine's two calls: before a turn (SQL into the state) and after it (the state into SQL). Neither ever throws: bookkeeping must not stop a game. */

/** Everyone who is here and has an account: the table's players, or the one person in a solo chat. */
export function peopleOf(session: Session, who: PlayerRef): { userId: string; actor: string }[] {
  const room = session.room;
  if (room && room.order.length) return room.order.map((id) => ({ userId: id, actor: room.players[id].actor })).filter((p) => p.userId !== "anonymous");
  return who.userId === "anonymous" ? [] : [{ userId: who.userId, actor: USER_ID }];
}

const on = (): boolean => !!stateDb() && !!(REHYDRATE || ELIGIBILITY);

/** Puts the stored values into `state`; returns the "since you slept" lines for the narrator. */
export async function rehydrateIn(session: Session, state: GameState, who: PlayerRef, now = Date.now()): Promise<string[]> {
  const db = stateDb();
  if (!db || !REHYDRATE) return [];
  const t0 = Date.now();
  const notes: string[] = [];
  try {
    for (const p of peopleOf(session, who)) notes.push(...(await pull(db, REHYDRATE, { ...p, state, now })));
  } catch (e) { console.warn("rehydrate failed:", (e as Error).message); }
  dbg("rehydrate")("pull %d ms, %d note(s)", Date.now() - t0, notes.length);
  console.log(`[rehydrate] pull ${Date.now() - t0} ms, ${notes.length} note(s)`);
  return notes;
}

/** Writes what changed, then lets the game's eligibility rules set or clear their flags. */
export async function rehydrateOut(session: Session, state: GameState, who: PlayerRef, now = Date.now()): Promise<void> {
  const db = stateDb();
  if (!on() || !db) return;
  const t0 = Date.now();
  try {
    for (const p of peopleOf(session, who)) {
      if (REHYDRATE) await push(db, REHYDRATE, { ...p, state, now });
      if (ELIGIBILITY?.rules.length) await applyRules(db, ELIGIBILITY, p.userId, p.actor, state, now);
    }
  } catch (e) { console.warn("rehydrate failed:", (e as Error).message); }
  console.log(`[rehydrate] push ${Date.now() - t0} ms`);
}
