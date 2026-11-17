import { stateDb } from "./db-state.js";
import { MODEL_ID } from "./config.js";
import type { Session } from "./types.js";

/**
 * Temporary bans from a table (config.json `ban`). A player who is caught looking at another's cards is put out for `hours`: they can still call into the table
 * and read, but the deal ignores them, they cannot play, their private channel is ignored and the narrator never hears them. The ban is kept in the session (fast)
 * and, when there is a database, in the `bans` table (so it holds across chats and restarts; the cleanup service removes expired rows).
 */
export const banKey = (table: string): string => table.slice(0, 200);

export async function ban(session: Session, table: string, userId: string, hours: number, reason: string, now = Date.now()): Promise<number> {
  const until = now + hours * 3_600_000;
  (session.bans ??= {})[userId] = until;
  const db = stateDb();
  if (db) {
    try {
      await db.deleteFrom("bans").where("user_id", "=", userId).where("game", "=", MODEL_ID).where("thread", "=", banKey(table)).execute();
      await db.insertInto("bans").values({ user_id: userId, game: MODEL_ID, thread: banKey(table), reason: reason.slice(0, 200), until, created_at: now, expires_at: until + 86_400_000 }).execute();
    } catch (e) { console.warn(`bans: could not write the ban: ${(e as Error).message}`); }
  }
  return until;
}

/** When the person's ban ends, or null when they are not banned. Reads the session first, then the database; a lapsed ban is forgotten. */
export async function bannedUntil(session: Session, table: string, userId: string, now = Date.now()): Promise<number | null> {
  const local = session.bans?.[userId];
  if (local && local > now) return local;
  if (local) delete session.bans![userId];
  const db = stateDb();
  if (!db) return null;
  try {
    const r = await db.selectFrom("bans").select("until").where("user_id", "=", userId).where("game", "=", MODEL_ID).where("thread", "=", banKey(table)).where("until", ">", now).executeTakeFirst();
    if (r) { const until = Number(r.until); (session.bans ??= {})[userId] = until; return until; }
  } catch (e) { console.warn(`bans: could not read the ban: ${(e as Error).message}`); }
  return null;
}
