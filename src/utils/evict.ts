import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDb } from "./db-state.js";
import { config, IMENG_PATH, MODEL_ID } from "./config.js";
import { bucketRemove } from "./bucket.js";
import { forgetSession, sessions, storeMode } from "./sessions.js";
import { allDocs, redisReady } from "./store.js";

/**
 * Eviction: when the bot is removed from a place where several people talk (a Discord server channel, a group chat, a thread), everything kept for that chat goes:
 * the live session (memory, saved file, Redis keys), every database row that belongs to it (attachments, PII token hashes, bans, succession candidates, ledger
 * entries) and its files in the bucket and the local cache. A place the bot is invited to again starts from nothing, so its first message must be the launch word.
 * Two-person chats (a DM, an Open WebUI single chat) are not evicted by leaving: there is nothing to leave. The rules live here, in code; `EVICT_TABLES` is the one list
 * to extend when a new table keeps data per chat.
 */
/** Money held by someone in the chat. Ids are hashed: the policy never sees a real user id. */
export interface Balance { user: string; debt: number; credit: number; banked: number }
export interface EvictPolicy { (e: { chat: string; game: string; balances: Balance[] }): { erase?: string[]; log?: string } | void | Promise<{ erase?: string[]; log?: string } | void> }
const uh = (id: string): string => crypto.createHash("sha256").update(`${MODEL_ID}:${id}`).digest("hex").slice(0, 16);
let policyCache: EvictPolicy | null | undefined;
async function policy(): Promise<EvictPolicy | null> {
  if (policyCache !== undefined) return policyCache;
  const file = typeof config.evict === "string" ? config.evict : "";
  if (!file) return (policyCache = null);
  const p = path.resolve(IMENG_PATH, file);
  if (!p.startsWith(path.resolve(IMENG_PATH) + path.sep) || !fs.existsSync(p)) { console.warn(`evict: ${file} not found inside the imeng folder; using the default (keep, log totals)`); return (policyCache = null); }
  const mod: any = await import(/* @vite-ignore */ p);
  const fn = mod.evictBalances ?? mod.default;
  return (policyCache = typeof fn === "function" ? fn : null);
}

export interface EvictReport { sessions: number; rows: Record<string, number>; files: number }

/** Database tables that hold data per chat, and the column that names the chat. */
export const EVICT_TABLES: { table: string; column: string }[] = [
  { table: "attachments", column: "session" },
  { table: "pii_tokens", column: "session" },
  { table: "bans", column: "thread" },
  { table: "candidates", column: "thread" },
  { table: "reentry_codes", column: "thread" },
];

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "none";

/** Every known chat key that starts with the prefix (live sessions, and in Redis mode the saved ones too). */
export async function keysWithPrefix(prefix: string): Promise<string[]> {
  const match = (k: string): boolean => [prefix, "chat:" + prefix].some((p) => k === p || k.startsWith(p + ":")); // chats are keyed "chat:<id>"
  const out = new Set([...sessions.keys()].filter(match));
  if (storeMode() === "redis" && redisReady()) {
    try { for await (const d of allDocs()) { try { const k = JSON.parse(d.body)?.key; if (typeof k === "string" && match(k)) out.add(k); } catch { /* not a session */ } } }
    catch (e) { console.warn(`evict: could not list the saved sessions: ${(e as Error).message}`); }
  }
  return [...out];
}

/** Drop one chat everywhere. Never throws; the report says what went. */
export async function evictChat(key: string): Promise<EvictReport> {
  const report: EvictReport = { sessions: 0, rows: {}, files: 0 };
  const known = sessions.get(key);
  const people = [...new Set([...Object.keys(known?.room?.players ?? {}), ...Object.keys(known?.own?.people ?? {})])];
  if (await forgetSession(key)) report.sessions++;
  const db = stateDb();
  if (db && people.length) await settleBalances(db, key, people, report);
  if (db) {
    try {
      const files = await db.selectFrom("attachments").select(["id", "bucket_key"]).where("session", "=", key).execute();
      for (const f of files as { id: string; bucket_key: string | null }[]) {
        if (f.bucket_key && (await bucketRemove(f.bucket_key))) report.files++;
        try { fs.rmSync(path.join(path.resolve(process.env.ATTACH_CACHE_DIR || "./_cache"), `${safe(key)}-${f.id}`), { force: true }); } catch { /* not staged */ }
      }
    } catch (e) { console.warn(`evict: could not list the files: ${(e as Error).message}`); }
    const tables = new Set((await db.introspection.getTables()).map((t) => t.name));
    for (const t of EVICT_TABLES) {
      if (!tables.has(t.table)) continue;
      try { const r = await db.deleteFrom(t.table).where(t.column, "=", key).executeTakeFirst(); report.rows[t.table] = Number(r.numDeletedRows ?? 0); }
      catch (e) { console.warn(`evict: could not purge ${t.table}: ${(e as Error).message}`); }
    }
  }
  return report;
}

/** Drop every chat under a prefix (a channel: `discord:<bot>:<channelId>` also takes the per-person chats `...:<channelId>:<userId>`). */
export async function evictPrefix(prefix: string): Promise<EvictReport & { chats: number }> {
  const keys = await keysWithPrefix(prefix);
  const total: EvictReport & { chats: number } = { sessions: 0, rows: {}, files: 0, chats: keys.length };
  for (const k of keys) {
    const r = await evictChat(k);
    total.sessions += r.sessions; total.files += r.files;
    for (const [t, n] of Object.entries(r.rows)) total.rows[t] = (total.rows[t] ?? 0) + n;
  }
  console.log(`evict: ${prefix}: ${total.chats} chat(s), ${total.sessions} session(s), ${total.files} file(s), rows ${JSON.stringify(total.rows)}`);
  return total;
}

/** Money held by people of the chat is not simply deleted: the imeng's policy decides (default: keep it and log totals). The log never carries a name or id. */
async function settleBalances(db: NonNullable<ReturnType<typeof stateDb>>, key: string, people: string[], report: EvictReport): Promise<void> {
  try {
    const tables = new Set((await db.introspection.getTables()).map((t) => t.name));
    if (!tables.has("ledger")) return;
    const rows = await db.selectFrom("ledger").select(["user_id", "debt", "credit", "banked"]).where("game", "=", MODEL_ID).where("user_id", "in", people).execute();
    const held = rows.filter((r) => Number(r.debt) || Number(r.credit) || Number(r.banked));
    if (!held.length) return;
    const balances: Balance[] = held.map((r) => ({ user: uh(String(r.user_id)), debt: Number(r.debt), credit: Number(r.credit), banked: Number(r.banked) }));
    const byHash = new Map(held.map((r) => [uh(String(r.user_id)), String(r.user_id)]));
    const chat = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    const fn = await policy();
    const out = (fn ? await fn({ chat, game: MODEL_ID, balances }) : undefined) ?? {};
    const sum = (k: "debt" | "credit" | "banked"): number => balances.reduce((n, b) => n + b[k], 0);
    console.log(`evict: ${out.log ?? `chat ${chat}: ${balances.length} balance(s) kept (debt ${sum("debt")}, credit ${sum("credit")}, banked ${sum("banked")})`}`);
    for (const h of out.erase ?? []) { const id = byHash.get(h); if (id) { await db.deleteFrom("ledger").where("game", "=", MODEL_ID).where("user_id", "=", id).execute(); report.rows.ledger = (report.rows.ledger ?? 0) + 1; } }
  } catch (e) { console.warn(`evict: balance policy failed, balances kept: ${(e as Error).message}`); }
}
