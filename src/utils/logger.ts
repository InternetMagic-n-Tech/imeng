import { dbg } from "./debug.js";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "redis";
import { REDIS_URL, LOG_STREAM, LOG_MAXLEN, LOG_PROMPT_CHARS, LOG_FILE, MODEL_ID } from "./config.js";
import { PERSIST } from "./cli.js";
import { onShutdown } from "./shutdown.js";
import { modelSpan } from "./mlflow.js";
import type { TraceBuf } from "./mlflow.js";
import type { Mode } from "./types.js";

// Traceability: every model response in a game chat is logged to a Redis stream (one JSON field,
// because Redis Commander only displays the first field of an entry). If Redis is unreachable the
// entry goes to a JSONL file instead, unless --no-persist is set, in which case it is dropped.

/** Per-request context: which session/turn/mode the log entries belong to. */
export interface RequestContext {
  session: string;
  turn: number | string;
  mode: Mode | "";
  /** The game turn (game.game_turn) after this request, when the game has game turns. */
  gameTurn?: number;
  /** The narrator reply before its <private> blocks came out: what the bookkeeping reads (the client got the visible text). */
  rawNarration?: string;
  /** Puts real names back into the reply (pii_filter.names); built per request. */
  piiRestore?: { push(t: string): string; end(): string };
  /** Fixed text added to the end of this reply (wrap_up.credits_file), not part of the narration. */
  tail?: string;
  /** Ids of files attached to this request and kept (the trace notes them; the bytes never go there). */
  attachments?: string[];
  /** The person this request is for (multiplayer rooms and traces). */
  user?: string;
  /** The MLflow experiment this request's trace goes to when each chat is its own experiment (utils/mlflow-chat.ts). */
  experimentId?: string;
  /** False when this chat's owner turned telemetry off: nothing of this request goes to MLflow. */
  telemetry?: boolean;
  /** Spans of this request waiting to go to MLflow (utils/mlflow.ts). */
  trace?: TraceBuf;
  /** Entries held back until the mode is known (see holdLogs/releaseLogs). */
  held?: LogItem[] | null;
}

export interface LogInfo {
  role: string;
  model?: string;
  prompt?: unknown;
  response?: unknown;
  ms?: number;
  error?: unknown;
}

interface LogItem {
  info: LogInfo;
  ts: string;
}

/** {session, turn, mode} for the request currently being served. */
export const reqCtx = new AsyncLocalStorage<RequestContext>();

/** The few redis client members the logger uses (keeps node-redis' heavy generics out of our types). */
export interface RedisLike {
  isReady: boolean;
  isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: "error", cb: (e: Error) => void): unknown;
  xAdd(key: string, id: string, message: Record<string, string>, opts?: unknown): Promise<string>;
  xDel(key: string, ids: string[]): Promise<unknown>;
  hSet(key: string, field: string, value: string): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { NX?: boolean; PX?: number; EX?: number }): Promise<string | null>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  del(keys: string | string[]): Promise<number>;
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
  scan(cursor: string | number, opts?: { MATCH?: string; COUNT?: number }): Promise<{ cursor: string | number; keys: string[] }>;
}
let redis: RedisLike | null = null;
let lastRedisWarn = 0;
const pending = new Set<Promise<void>>(); // in-flight log writes
const written = new Map<string, string[]>(); // --no-persist: session -> Redis entry ids written by this process

/** The connected Redis client, or null (used for small shared data such as chat links; the log is the main user). */
export const redisClient = (): RedisLike | null => redis;

export async function startRedis(): Promise<void> {
  if (!REDIS_URL) {
    console.warn("REDIS_URL not set; model responses will be " + (PERSIST ? `logged to ${LOG_FILE}` : "discarded (--no-persist)"));
    return;
  }
  const client = createClient({
    url: REDIS_URL,
    disableOfflineQueue: true, // fail fast so we can fall back to the file
    socket: { connectTimeout: 3000, reconnectStrategy: (n: number) => Math.min(n * 500, 5000) },
  }) as unknown as RedisLike;
  dbg("redis")("connecting");
  client.on("error", (e: Error) => {
    dbg("redis")("error: %s", e.message);
    if (Date.now() - lastRedisWarn > 30000) { lastRedisWarn = Date.now(); console.warn("redis:", e.message); }
  });
  try {
    await client.connect();
    redis = client;
    console.log(`Logging model responses to redis stream "${LOG_STREAM}"${PERSIST ? "" : " (will be purged on exit: --no-persist)"}`);
  } catch (e) {
    console.warn("redis unavailable:", (e as Error).message);
  }
  onShutdown(closeLogger);
}

const cap = (v: unknown, n: number = LOG_PROMPT_CHARS): string => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > n ? t.slice(0, n) + `…[truncated ${t.length - n} chars]` : t;
};

/**
 * Only game-mode sessions are logged. Direct (non-game) chats are never stored, so entries made
 * before the mode is known are held (holdLogs) and then kept or dropped (releaseLogs).
 * Fire-and-forget; never lets logging break a game turn.
 */
export function logModel(info: LogInfo): void {
  const c = reqCtx.getStore();
  const item: LogItem = { info, ts: new Date().toISOString() };
  if (c?.held) { c.held.push(item); return; }
  if (c?.mode !== "game") return;
  write(item, c);
}

/** Start holding this request's log entries until its mode is decided. */
export function holdLogs(): void {
  const c = reqCtx.getStore();
  if (c) c.held = [];
}

/** Stop holding: write the held entries if keep is true (game mode), otherwise discard them. */
export function releaseLogs(keep: boolean): void {
  const c = reqCtx.getStore();
  if (!c?.held) return;
  const held = c.held;
  c.held = null;
  if (keep) for (const item of held) write(item, c);
}

function write({ info: { role, model, prompt, response, ms, error }, ts }: LogItem, c: RequestContext): void {
  const entry = {
    ts, game: MODEL_ID, role, model: model || "", session: c.session || "", turn: String(c.turn ?? ""),
    mode: c.mode || "", ms: String(ms ?? ""), prompt: cap(prompt ?? ""), response: cap(response ?? "", 50000),
    error: error ? String(error) : "",
  };
  modelSpan(c, { role, model, prompt, response, ms, error, ts });
  const p = (async () => {
    try {
      if (!redis?.isReady) throw new Error("redis not ready");
      // One field only: Redis Commander shows just the first field/value of a stream entry.
      const id = await redis.xAdd(LOG_STREAM, "*", { entry: JSON.stringify(entry) },
        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: LOG_MAXLEN } });
      if (!PERSIST) {
        if (!written.has(entry.session)) written.set(entry.session, []);
        written.get(entry.session)!.push(id);
      }
    } catch {
      if (!PERSIST) return; // ephemeral run: nothing is kept
      try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
      } catch (e) { console.warn("could not log model response:", (e as Error).message); }
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** --no-persist: delete every log entry this process wrote, i.e. for all sessions it created. */
async function purgeWritten(): Promise<void> {
  await Promise.allSettled([...pending]);
  const ids = [...written.values()].flat();
  if (!ids.length || !redis?.isReady) return;
  for (let i = 0; i < ids.length; i += 500) await redis.xDel(LOG_STREAM, ids.slice(i, i + 500));
  const sessions = [...written.keys()].filter(Boolean);
  console.log(`--no-persist: removed ${ids.length} Redis log entries from ${sessions.length} session(s)`);
  for (const s of sessions) console.log(`  - ${s}`);
  written.clear();
}

export async function closeLogger(): Promise<void> {
  if (!PERSIST) await purgeWritten();
  else await Promise.allSettled([...pending]);
  if (redis?.isOpen) await redis.quit();
}

/** Test helper: wait for in-flight log writes. */
export async function flushLogs(): Promise<void> {
  await Promise.allSettled([...pending]);
}
