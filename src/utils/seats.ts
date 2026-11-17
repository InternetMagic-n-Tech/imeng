import fs from "node:fs";
import path from "node:path";
import { SAVE_DIR, SESSION_PREFIX } from "./config.js";
import { PERSIST } from "./cli.js";
import { redisClient } from "./logger.js";

/**
 * Who sits at which table. Speaking at a table (a chat shared with "Allow replies", or a channel) gives that person a seat, remembered by the
 * Open WebUI user id the request carries. A new chat of a seated person is then their private channel to the narrator. The map lives in memory,
 * in SAVE_DIR/seats.json and, when REDIS_URL is set, in the Redis hash `<SESSION_PREFIX>:seats` (so a restart or a second proxy container sees the same seats).
 */

export interface Seat { table: string; at: number }
/** Open WebUI user id -> their seat (the session key of the table, and when they last spoke there). */
export const seats = new Map<string, Seat>();
const HASH = `${SESSION_PREFIX}:seats`; // per game, so games can share a Redis
const REFRESH_MS = 3_600_000; // a seat that is already right is rewritten at most hourly
const file = (): string => path.join(SAVE_DIR, "seats.json");
let loaded: Promise<void> | null = null;
let lastWarn = 0;
const warn = (m: string, e: unknown): void => { if (Date.now() - lastWarn > 30000) { lastWarn = Date.now(); console.warn(m, (e as Error).message); } };

function saveFile(): void {
  if (!PERSIST) return;
  try { fs.mkdirSync(SAVE_DIR, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(seats))); }
  catch (e) { warn("could not save seats:", e); }
}

/** The table this person sits at, or null (never sat, or not seen there for `ttlMs`). */
export function seatOf(userId: string, now: number, ttlMs: number): string | null {
  const s = seats.get(userId);
  return s && now - s.at <= ttlMs ? s.table : null;
}

/** This person spoke at this table. */
export async function seat(userId: string, table: string, now: number): Promise<void> {
  const old = seats.get(userId);
  if (old && old.table === table && now - old.at < REFRESH_MS) return;
  const s = { table, at: now };
  seats.set(userId, s);
  saveFile();
  const r = redisClient();
  if (r?.isReady) { try { await r.hSet(HASH, userId, JSON.stringify(s)); } catch (e) { warn("could not save seat to redis:", e); } }
}

/** This person left the table. */
export async function unseat(userId: string): Promise<void> {
  if (!seats.delete(userId)) return;
  saveFile();
  const r = redisClient();
  if (r?.isReady) { try { await r.hDel(HASH, userId); } catch (e) { warn("could not remove seat from redis:", e); } }
}

/** Read the saved seats once (file, then Redis). */
export function loadSeats(): Promise<void> {
  loaded ??= (async () => {
    const add = (k: string, v: unknown): void => { const s = v as Seat; if (s && typeof s.table === "string" && Number.isFinite(s.at)) seats.set(k, s); };
    if (PERSIST) { try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file(), "utf8")))) add(k, v); } catch { /* none yet */ } }
    const r = redisClient();
    if (r?.isReady) {
      try { for (const [k, v] of Object.entries(await r.hGetAll(HASH))) { try { add(k, JSON.parse(v)); } catch { /* skip */ } } }
      catch (e) { warn("could not read seats from redis:", e); }
    }
  })();
  return loaded;
}

/** Tests: forget everything, including that seats were loaded. */
export function _resetSeats(): void { seats.clear(); loaded = null; }

/** The actor a real person plays: their seat in the room, or "user" when the chat has no room yet (one human alone, or no user id). Never invents a seat at a table. */
export const seatActor = (session: { room?: { players?: Record<string, { actor?: string }> } | null }, userId: string): string | undefined =>
  session.room?.players?.[userId]?.actor ?? (!session.room || userId === "anonymous" ? "user" : undefined);
