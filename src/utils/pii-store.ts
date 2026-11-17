import { stateDb } from "./db-state.js";
import { MODEL_ID, SESSION_TTL_DAYS } from "./config.js";

/**
 * The long-term record of which PII tokens a chat has used (table `pii_tokens`): the salted hash from the token is the key and the session the second key. The real
 * value is NEVER stored (a hash alone cannot be turned back into a name); what this gives is a store a resumed chat can refresh its tokens against, a count of what each
 * chat has hidden, and one place that deletes a chat's tokens with the chat. Best effort: a database that is down never stops a game.
 */
export const TOKEN = /^\[([a-z][a-z0-9_+]*):([0-9a-f]{6,})\]$/;

/** The (kind, hash) pairs of a list of tokens; anything that is not a salted-hash token (a fixed placeholder like [SECRET]) is skipped. */
export function parseTokens(tokens: Iterable<string>): { kind: string; hash: string }[] {
  const seen = new Set<string>(), out: { kind: string; hash: string }[] = [];
  for (const t of tokens) { const m = TOKEN.exec(t); if (m && !seen.has(m[2]!)) { seen.add(m[2]!); out.push({ kind: m[1]!, hash: m[2]! }); } }
  return out;
}

export async function recordTokens(session: string, tokens: Iterable<string>, now = Date.now()): Promise<number> {
  const db = stateDb();
  const found = parseTokens(tokens);
  if (!db || !found.length) return 0;
  const expires = now + SESSION_TTL_DAYS * 86_400_000;
  try {
    for (const t of found) {
      const upd = await db.updateTable("pii_tokens").set({ last_seen: now, expires_at: expires }).where("hash", "=", t.hash).where("session", "=", session).executeTakeFirst();
      if (!Number(upd.numUpdatedRows ?? 0)) await db.insertInto("pii_tokens").values({ hash: t.hash, session, game: MODEL_ID, kind: t.kind, first_seen: now, last_seen: now, expires_at: expires }).execute();
    }
    return found.length;
  } catch (e) { console.warn(`pii store: could not record tokens: ${(e as Error).message}`); return 0; }
}

/** The tokens a chat has used (hash and kind only): what a resumed chat refreshes from. */
export async function tokensOf(session: string): Promise<{ hash: string; kind: string }[]> {
  const db = stateDb();
  if (!db) return [];
  try { return (await db.selectFrom("pii_tokens").select(["hash", "kind"]).where("session", "=", session).execute()) as { hash: string; kind: string }[]; } catch { return []; }
}

/** Forget a chat's tokens (the chat was deleted). */
export async function forgetTokens(session: string): Promise<void> {
  const db = stateDb();
  if (!db) return;
  try { await db.deleteFrom("pii_tokens").where("session", "=", session).execute(); } catch { /* best effort */ }
}
