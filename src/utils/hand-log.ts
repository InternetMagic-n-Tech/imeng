import crypto from "node:crypto";
import { MODEL_ID } from "./config.js";
import { stateDb } from "./db-state.js";
import type { GameState, Session } from "./types.js";

/**
 * The house's database copy of a server-kept hand (migration 007_hand_log): kind "deal" (hole cards and the face-down board, as set) and "bet" (each action and what it did).
 * Append only, keyed by session and turn (snapshots.length when written). The snapshots stay the truth; a failed write is a warning, never a changed game.
 * Nothing happens without a database (DATABASE_URL), and a game with deal or betting "server" refuses to start without one (bootstrap).
 */
const KEEP_MS = 30 * 24 * 3600 * 1000;

export async function logHand(session: Session | undefined, state: GameState, kind: "deal" | "bet" | "tip" | "pay" | "seat" | "settings", body: unknown): Promise<void> {
  const db = stateDb();
  if (!db || !session) return;
  try {
    const now = Date.now();
    await db.insertInto("hand_log").values({ session: (session.logId ??= crypto.randomUUID()), game: MODEL_ID, turn: session.snapshots.length, hand: Number(state.game.hand) || 0, kind, body: JSON.stringify(body), created_at: now, expires_at: now + KEEP_MS }).execute();
  } catch (e) { console.warn(`hand log not written: ${(e as Error).message}`); }
}

/** A rollback to `turn` turns: rows written after it go. */
export async function trimHandLog(session: Session, turn: number): Promise<void> {
  const db = stateDb();
  if (!db || !session.logId) return;
  try { await db.deleteFrom("hand_log").where("session", "=", session.logId).where("turn", ">", turn).execute(); } catch (e) { console.warn(`hand log not trimmed: ${(e as Error).message}`); }
}
