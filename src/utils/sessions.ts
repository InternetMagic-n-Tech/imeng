import fs from "node:fs";
import { dbg } from "./debug.js";
import path from "node:path";
import crypto from "node:crypto";
import { SAVE_DIR, GAME_VERSION, SAVE_COALESCE_MS, PRODUCTION, SESSION_STORE, REDIS_URL, GAME_SCHEMA_VERSION, SESSION_SCHEMA } from "./config.js";
import { redisReady, loadDoc, saveDoc, acquireLock, allDocs, keysFor, redisDelete } from "./store.js";
import { judgeSchema, upgradeDoc, schemaProblem, SchemaMismatch } from "./session-schema.js";
import type { Lock } from "./store.js";
import { onShutdown } from "./shutdown.js";
import { PERSIST } from "./cli.js";
import { initialState } from "./state.js";
import { contentText, digest, squash } from "./text.js";
import type { ChatMessage, HeaderSource, Session } from "./types.js";

// snapshots[i] = state after i user turns (so regenerate/edit can roll back).
// Saved to SAVE_DIR so restarts don't lose games, unless --no-persist is set.
export const sessions = new Map<string, Session>();

const fileFor = (key: string): string => path.join(SAVE_DIR, crypto.createHash("sha1").update(key).digest("hex") + ".json");
const freshSession = (tail: Promise<unknown> = Promise.resolve()): Session => ({ snapshots: [initialState()], unsynced: [], gameVersion: GAME_VERSION, tail });

/** A warning when a save was made by another major version of the game (state shape or rules may differ); null when nothing to say. */
export function versionNote(saved: string | null, now: string | null): string | null {
  if (!now) return null;
  if (!saved) return `has no game version; the game is now ${now}. If it is from before a major change it may not fit`;
  const [a, b] = [saved, now].map((v) => parseInt(v, 10));
  return a !== b ? `was made with game version ${saved}, the game is now ${now} (major change: the state or rules may not fit; start a new chat if it misbehaves)` : null;
}

const payload = (key: string, s: Session): string => JSON.stringify({ key, schema_version: GAME_SCHEMA_VERSION, snapshots: s.snapshots, unsynced: s.unsynced, mode: s.mode, game_version: s.gameVersion, summary: s.summary, wrapUp: s.wrapUp, violations: s.violations, room: s.room, visuals: s.visuals, frozen: s.frozen, freezeNotes: s.freezeNotes, owner: s.owner, own: s.own, privateFor: s.privateFor, knowledge: s.knowledge, goals: s.goals, tools: s.tools, prints: s.prints, audit: s.audit, approximate: s.approximate, syncFailures: s.syncFailures, abandoned: s.abandoned, logId: s.logId, announcements: s.announcements, credit: s.credit, cardLog: s.cardLog, guesses: s.guesses, viewers: s.viewers, peeks: s.peeks, signals: s.signals });

/** A saved document (a file, or Redis) as a live session. */
function fromDoc(d: any, label: string): Session {
  const v = judgeSchema(d, GAME_SCHEMA_VERSION, SESSION_SCHEMA);
  if (v.action === "refuse") throw new SchemaMismatch(`save ${label} ${v.note}`);
  if (v.action === "warn") console.warn(`save ${label} ${v.note}`);
  if (v.action === "migrate") d = upgradeDoc(d, v.from, v.to);
  const saved: string | null = typeof d.game_version === "string" ? d.game_version : null;
  const note = versionNote(saved, GAME_VERSION);
  if (note) console.warn(`save ${label}: ${note}`);
  return { snapshots: d.snapshots, unsynced: d.unsynced || [], mode: d.mode, gameVersion: saved ?? GAME_VERSION, summary: d.summary, wrapUp: d.wrapUp, violations: d.violations, room: d.room, visuals: d.visuals, frozen: d.frozen, freezeNotes: d.freezeNotes, owner: d.owner, own: d.own, privateFor: d.privateFor, knowledge: d.knowledge, goals: d.goals, tools: d.tools, prints: d.prints, audit: d.audit, approximate: d.approximate, syncFailures: d.syncFailures, abandoned: d.abandoned, logId: d.logId, announcements: d.announcements, credit: d.credit, cardLog: d.cardLog, guesses: d.guesses, viewers: d.viewers, peeks: d.peeks, signals: d.signals, tail: Promise.resolve() };
}

// ---------- where sessions are kept ----------
// memory (--no-persist / npm run start:ephemeral): nothing is saved.  file (npm start): SAVE_DIR/*.json, human readable.
// redis (production, or SESSION_STORE=redis): shared by every proxy server; a turn takes a per-session lock, reads the newest copy first and saves
// with a version check (utils/store.ts). Without a connection it falls back to files and says so.
export type StoreMode = "memory" | "file" | "redis";
let warnedFallback = false;
export function storeMode(): StoreMode {
  if (!PERSIST) return "memory";
  const want = SESSION_STORE === "auto" ? (PRODUCTION && REDIS_URL ? "redis" : "file") : SESSION_STORE;
  if (want !== "redis") return "file";
  if (redisReady()) return "redis";
  if (!warnedFallback) { warnedFallback = true; console.warn("Sessions should be in Redis but Redis is not connected: using files (safe for one server only)"); }
  return "file";
}

function writeNow(key: string, body: string): void {
  const file = fileFor(key);
  fs.writeFileSync(file + ".tmp", body);
  fs.renameSync(file + ".tmp", file); // atomic
}

// SAVE_COALESCE_MS > 0: saves wait here, one per session, and are written off the request path.
const queued = new Map<string, Session>();
const lastWritten = new Map<string, string>(); // key -> digest of the file as written, so an unchanged state is not rewritten
let timer: NodeJS.Timeout | null = null;
let writing: Promise<void> = Promise.resolve();

async function writeQueued(): Promise<void> {
  const batch = [...queued]; queued.clear();
  for (const [key, s] of batch) {
    const body = payload(key, s), sig = digest(body);
    if (lastWritten.get(key) === sig) continue;
    const t0 = Date.now();
    const file = fileFor(key);
    try {
      await fs.promises.writeFile(file + ".tmp", body);
      await fs.promises.rename(file + ".tmp", file);
      lastWritten.set(key, sig);
      if (Date.now() - t0 > 250) console.warn(`slow session save (${Date.now() - t0} ms, ${(body.length / 1024).toFixed(0)} KB): ${key}`);
    } catch (e) { console.warn("could not save session:", (e as Error).message); queued.set(key, s); }
  }
}

/** Write everything waiting (a clean exit, tests). */
export async function flushSaves(): Promise<void> {
  for (const key of [...redisQueue.keys()]) { try { await flushSession(key); } catch (e) { console.warn("could not save session to Redis:", (e as Error).message); } }
  if (timer) { clearTimeout(timer); timer = null; }
  writing = writing.then(writeQueued, writeQueued);
  await writing;
}

// Redis mode: saves wait here until the turn ends (flushSession), so one turn writes each session once.
const redisQueue = new Map<string, Session>();

/** Redis mode: write this session now (compare-and-set on the version it was read at). A copy that someone else got ahead of is dropped. */
export async function flushSession(key: string): Promise<void> {
  const s = redisQueue.get(key);
  if (!s) return;
  redisQueue.delete(key);
  const r = await saveDoc(key, payload(key, s), s.version ?? 0);
  if (r.ok) s.version = r.version;
  else { console.error(`session ${key} was changed by another server (now version ${r.version}); this copy is dropped and re-read on the next turn`); if (sessions.get(key) === s) sessions.delete(key); }
}

/** Read the newest saved copy into memory (Redis mode; a no-op otherwise). Call it holding the session's lock. */
export async function hydrate(key: string): Promise<void> {
  if (storeMode() !== "redis") return;
  const d = await loadDoc(key);
  if (!d) return;
  const have = sessions.get(key);
  if (have && (have.version ?? -1) >= d.version) return;
  try {
    const s = fromDoc(JSON.parse(d.body), key);
    s.version = d.version;
    if (have) s.tail = have.tail;
    sessions.set(key, s);
  } catch (e) { if (e instanceof SchemaMismatch) throw e; console.warn(`bad session in Redis (${key}):`, (e as Error).message); }
}

/** Redis mode: look at every stored session once at startup (headers only matter; up to SESSION_SCHEMA_SCAN_LIMIT, default 5000). A message when the server must not start, else null. */
export async function redisSchemaProblem(): Promise<string | null> {
  if (storeMode() !== "redis" || SESSION_SCHEMA !== "refuse") return null;
  const docs: { key: string; doc: unknown }[] = [];
  const limit = Math.max(1, Number(process.env.SESSION_SCHEMA_SCAN_LIMIT || 5000) || 5000);
  for await (const d of allDocs()) { try { const j = JSON.parse(d.body); docs.push({ key: String(j.key ?? d.hash), doc: j }); } catch { /* an unreadable one is reported when used */ } if (docs.length >= limit) break; }
  return schemaProblem(docs, GAME_SCHEMA_VERSION, SESSION_SCHEMA, undefined, limit);
}

export interface Lease { key: string; lock: Lock }

/** Start a turn on a session: in Redis mode wait for its lock (across servers) and read the newest copy. Null when there is nothing to lock. */
export async function beginSession(key: string | null): Promise<Lease | null> {
  if (!key || storeMode() !== "redis") return null;
  const lock = await acquireLock(key);
  try { await hydrate(key); } catch (e) { await lock.release(); throw e; }
  return { key, lock };
}

/** End the turn: save what changed, then give the session back. Never throws. */
export async function endSession(lease: Lease | null): Promise<void> {
  if (!lease) return;
  try { await flushSession(lease.key); }
  catch (e) { console.warn(`could not save session ${lease.key} to Redis:`, (e as Error).message); }
  finally { await lease.lock.release(); }
}

export function saveSession(key: string, s: Session): void {
  if (!PERSIST) return;
  dbg("session")("save %s (turn %d, %s)", key, s.snapshots.length - 1, storeMode());
  if (storeMode() === "redis") { redisQueue.set(key, s); return; }
  if (!SAVE_COALESCE_MS) { writeNow(key, payload(key, s)); return; }
  queued.set(key, s);
  if (!timer) timer = setTimeout(() => { timer = null; void flushSaves(); }, SAVE_COALESCE_MS).unref();
}

/** Forget one chat completely: memory, the saved file, the Redis keys. Returns true when something was there. */
export async function forgetSession(key: string): Promise<boolean> {
  const had = sessions.delete(key);
  redisQueue.delete(key);
  dropSaveFile(key);
  if (storeMode() === "redis") { try { const k = keysFor(key); await redisDelete([k.doc, k.ver, k.lock]); } catch (e) { console.warn(`evict: could not delete the Redis keys: ${(e as Error).message}`); } }
  return had;
}

function dropSaveFile(key: string): void {
  if (!PERSIST) return;
  queued.delete(key); lastWritten.delete(key);
  try { fs.unlinkSync(fileFor(key)); } catch { /* nothing to remove */ }
}

export function loadSessions(): void {
  if (!PERSIST) { console.log("--no-persist: sessions are kept in memory only"); return; }
  if (storeMode() === "redis") { console.log("Sessions are in Redis: each is read when its chat is next used"); onShutdown(flushSaves); return; }
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  for (const f of fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SAVE_DIR, f), "utf8"));
      sessions.set(d.key, fromDoc(d, f));
    } catch (e) { if (e instanceof SchemaMismatch) throw e; console.warn("skipping bad save", f, (e as Error).message); }
  }
  if (SAVE_COALESCE_MS) onShutdown(flushSaves);
  if (sessions.size) console.log(`Loaded ${sessions.size} saved session(s)`);
}

let warnedNoChatId = false;

export type Promote = (narration: string) => string;

/**
 * Returns [key, session, promote, created]. `created` is true when this call made a brand-new session
 * (the caller can warn if that happens mid-conversation). One game per Open WebUI chat (X-OpenWebUI-Chat-Id).
 * Without that header, falls back to user + first message + first reply; promote(narration)
 * re-registers a first-turn session under a reply-derived key so interleaved chats can't cross.
 */
export function sessionFor(req: HeaderSource, messages: ChatMessage[]): [string, Session, Promote | null, boolean] {
  let created = false;
  let promote: Promote | null = null;
  const chatId = req.get("x-openwebui-chat-id");
  let key: string;
  if (chatId) {
    key = "chat:" + chatId;
  } else {
    if (!warnedNoChatId) {
      warnedNoChatId = true;
      console.warn("No X-OpenWebUI-Chat-Id header; set ENABLE_FORWARD_USER_INFO_HEADERS=true in Open WebUI for reliable per-chat state. Using a content-based fallback.");
    }
    const uid = req.get("x-openwebui-user-id") || "";
    const iUser = messages.findIndex((m) => m.role === "user");
    const first = squash(contentText(messages[iUser]?.content));
    const reply = messages.slice(iUser + 1).find((m) => m.role === "assistant");
    const pendingKey = "pending:" + digest(uid + "\u0000" + first);
    if (!reply) {
      // Brand-new game (first turn): always start fresh, even if the opener repeats.
      key = pendingKey;
      const fresh = freshSession(sessions.get(key)?.tail);
      sessions.set(key, fresh);
      promote = (narration) => {
        const k = "hash:" + digest(uid + "\u0000" + first + "\u0000" + squash(narration));
        sessions.set(k, fresh);
        if (sessions.get(pendingKey) === fresh) sessions.delete(pendingKey);
        dropSaveFile(pendingKey);
        return k;
      };
    } else {
      key = "hash:" + digest(uid + "\u0000" + first + "\u0000" + squash(contentText(reply.content)));
      if (!sessions.has(key) && sessions.has(pendingKey)) {
        sessions.set(key, sessions.get(pendingKey)!); // promote the first-turn session
        sessions.delete(pendingKey);
        dropSaveFile(pendingKey);
      }
    }
  }
  if (!sessions.has(key)) {
    sessions.set(key, freshSession());
    created = true;
  }
  return [key, sessions.get(key)!, promote, created];
}

/** Test helper: forget the "warned once" flag. */
export function _resetSessionWarnings(): void {
  warnedNoChatId = false;
}
