import crypto from "node:crypto";
import { SESSION_PREFIX, SESSION_TTL_DAYS, LOCK_TTL_MS, LOCK_WAIT_MS } from "./config.js";
import { redisClient } from "./logger.js";
import type { RedisLike } from "./logger.js";

/**
 * Sessions in Redis (production). Three keys per session under SESSION_PREFIX:
 *   :s:<sha1 of the session key>:doc   the session as JSON
 *   :s:<sha1>:ver                      a counter that goes up with every write
 *   :s:<sha1>:lock                     who is running a turn on this session right now
 * Turns on one session run one at a time across all proxy servers (the lock, with a lease that is renewed while the turn runs, so a crashed server
 * frees the session after LOCK_TTL_MS). Every write also states which version it was based on (compare-and-set), so a server that lost its lease
 * cannot overwrite what a newer turn saved.
 */

const ttlSeconds = (): number => SESSION_TTL_DAYS * 86400;
const hash = (key: string): string => crypto.createHash("sha1").update(key).digest("hex");
export interface SessionKeys { doc: string; ver: string; lock: string }
export const keysFor = (key: string, prefix = SESSION_PREFIX): SessionKeys => { const b = `${prefix}:s:${hash(key)}`; return { doc: b + ":doc", ver: b + ":ver", lock: b + ":lock" }; };

const client = (): RedisLike => {
  const r = redisClient();
  if (!r?.isReady) throw new Error("Redis is not connected");
  return r;
};
export const redisReady = (): boolean => !!redisClient()?.isReady;

const CAS = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '0')
if cur ~= tonumber(ARGV[1]) then return {0, cur} end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[2], tostring(cur + 1), 'EX', ARGV[3])
return {1, cur + 1}`;
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** The saved session and its version, or null. */
export async function loadDoc(key: string, prefix = SESSION_PREFIX): Promise<{ body: string; version: number } | null> {
  const k = keysFor(key, prefix);
  const [doc, ver] = await client().mGet([k.doc, k.ver]);
  return doc ? { body: doc, version: Number(ver) || 0 } : null;
}

/** Save `body` if the session is still at `expected` (0: never saved). Returns the new version, or the version that is there when someone else got in first. */
export async function saveDoc(key: string, body: string, expected: number, prefix = SESSION_PREFIX): Promise<{ ok: boolean; version: number }> {
  const k = keysFor(key, prefix);
  const r = (await client().eval(CAS, { keys: [k.doc, k.ver], arguments: [String(expected), body, String(ttlSeconds())] })) as [number, number];
  return { ok: Number(r[0]) === 1, version: Number(r[1]) };
}

export interface Lock { release(): Promise<void>; /** True once the lease could not be renewed: this holder must assume someone else may be running. */ readonly lost: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for the right to run a turn on this session (at most `wait` ms), then hold it, renewing the lease, until release(). */
export async function acquireLock(key: string, opts: { ttl?: number; wait?: number } = {}): Promise<Lock> {
  const ttl = opts.ttl ?? LOCK_TTL_MS, wait = opts.wait ?? LOCK_WAIT_MS;
  const { lock } = keysFor(key);
  const token = crypto.randomUUID();
  const deadline = Date.now() + wait;
  for (let n = 0; ; n++) {
    if ((await client().set(lock, token, { NX: true, PX: ttl })) === "OK") break;
    if (Date.now() >= deadline) throw new Error("this game is busy (another turn is still running); try again in a moment");
    await sleep(Math.min(40 * 2 ** Math.min(n, 4), 500));
  }
  let lost = false, released = false;
  const timer = setInterval(() => {
    client().eval(RENEW, { keys: [lock], arguments: [token, String(ttl)] }).then((r) => { if (Number(r) !== 1) { lost = true; clearInterval(timer); } }, () => { /* a blip: the next renewal tries again */ });
  }, Math.max(200, Math.floor(ttl / 3)));
  timer.unref();
  return {
    get lost() { return lost; },
    async release() {
      if (released) return;
      released = true; clearInterval(timer);
      try { await client().eval(RELEASE, { keys: [lock], arguments: [token] }); } catch { /* the lease expires by itself */ }
    },
  };
}

// ---------- maintenance (npm run sessions) ----------

/** Every saved session of a game: [session key hash, JSON body]. */
export async function* allDocs(prefix = SESSION_PREFIX): AsyncGenerator<{ hash: string; body: string; version: number }> {
  const r = client();
  let cursor: string | number = "0";
  do {
    const res: { cursor: string | number; keys: string[] } = await r.scan(cursor, { MATCH: `${prefix}:s:*:doc`, COUNT: 200 });
    cursor = res.cursor;
    for (const docKey of res.keys) {
      const verKey = docKey.replace(/:doc$/, ":ver");
      const [body, ver] = await r.mGet([docKey, verKey]);
      if (body) yield { hash: docKey.slice(`${prefix}:s:`.length, -4), body, version: Number(ver) || 0 };
    }
  } while (String(cursor) !== "0");
}

/** Remove every session of a game (documents, versions, locks). Returns how many keys went. */
export async function clearAll(prefix = SESSION_PREFIX): Promise<number> {
  const r = client();
  let n = 0, cursor: string | number = "0";
  do {
    const res: { cursor: string | number; keys: string[] } = await r.scan(cursor, { MATCH: `${prefix}:s:*`, COUNT: 200 });
    cursor = res.cursor;
    if (res.keys.length) n += await r.del(res.keys);
  } while (String(cursor) !== "0");
  return n;
}

/** Delete keys by name (a chat's document, version and lock). */
export async function redisDelete(keys: string[]): Promise<number> { return keys.length ? await client().del(keys) : 0; }
