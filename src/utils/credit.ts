import crypto from "node:crypto";
import type { Db } from "./db.js";

/**
 * Credit, debt and re-entry (config.json `credit`). A player who busts is given a code shown only to them. The code is single use and expires; only its hash is kept. It
 * lets them back in once it is marked paid (a state change from the outside service or the owner) or they hold enough credit. The owner alone may lend, as debt up to a limit.
 * All of it is decided here, in code, from the database: the narrator never touches money. A frozen player's NPC never borrows (see `mayBorrow`).
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no look-alikes
export const hashCode = (code: string): string => crypto.createHash("sha256").update(code.trim().toUpperCase().replace(/[\s-]/g, "")).digest("hex");
const makeCode = (): string => { const b = crypto.randomBytes(8); const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join(""); return `${s.slice(0, 4)}-${s.slice(4)}`; };
const YEAR = 365 * 86_400_000;

export interface Who { game: string; userId: string }

export async function issueCode(db: Db, w: Who & { thread: string; ttlMs: number; now?: number; price?: number; currency?: string }): Promise<string> {
  const now = w.now ?? Date.now();
  await db.deleteFrom("reentry_codes").where("game", "=", w.game).where("user_id", "=", w.userId).where("used_at", "is", null).execute(); // a new code replaces the old unused one
  const code = makeCode();
  await db.insertInto("reentry_codes").values({ code_hash: hashCode(code), game: w.game, thread: w.thread, user_id: w.userId, paid: 0, used_at: null, created_at: now, valid_until: now + w.ttlMs, expires_at: now + w.ttlMs + 30 * 86_400_000, told_owner: 0, price: w.price ?? null, currency: w.currency ?? null }).execute();
  return code;
}

/** The outside service (or the owner) says the code was paid. */
export async function markPaid(db: Db, code: string): Promise<boolean> { return (await markPaidChecked(db, code)).ok; }

/** As markPaid, but the payment's own terms must match the ones the code was issued under: a different currency or amount is refused ("terms"), and with `require` a payment that names neither is too. */
export async function markPaidChecked(db: Db, code: string, terms: { amount?: unknown; currency?: unknown; require?: boolean } = {}): Promise<{ ok: boolean; reason?: "unknown" | "terms" }> {
  const row = await db.selectFrom("reentry_codes").select(["price", "currency"]).where("code_hash", "=", hashCode(code)).where("used_at", "is", null).executeTakeFirst();
  if (!row) return { ok: false, reason: "unknown" };
  const hasA = terms.amount !== undefined, hasC = terms.currency !== undefined;
  if ((terms.require && (!hasA || !hasC)) || (hasC && row.currency != null && String(terms.currency) !== String(row.currency)) || (hasA && row.price != null && Number(terms.amount) !== Number(row.price))) return { ok: false, reason: "terms" };
  const r = await db.updateTable("reentry_codes").set({ paid: 1 }).where("code_hash", "=", hashCode(code)).where("used_at", "is", null).executeTakeFirst();
  return { ok: Number(r.numUpdatedRows ?? 0) > 0 };
}

export async function ledgerOf(db: Db, w: Who): Promise<{ debt: number; credit: number; banked: number }> {
  const r = await db.selectFrom("ledger").select(["debt", "credit", "banked"]).where("game", "=", w.game).where("user_id", "=", w.userId).executeTakeFirst();
  return { debt: Number(r?.debt ?? 0), credit: Number(r?.credit ?? 0), banked: Number(r?.banked ?? 0) };
}
async function setLedger(db: Db, w: Who, v: { debt: number; credit: number; banked: number }, now: number): Promise<void> {
  const row = { debt: v.debt, credit: v.credit, banked: v.banked, updated_at: now, expires_at: now + YEAR };
  const u = await db.updateTable("ledger").set(row).where("game", "=", w.game).where("user_id", "=", w.userId).executeTakeFirst();
  if (!Number(u.numUpdatedRows ?? 0)) await db.insertInto("ledger").values({ game: w.game, user_id: w.userId, ...row }).execute();
}

/** Money the outside service says a player has paid in (play credit). */
export async function addCredit(db: Db, w: Who, amount: number, now = Date.now()): Promise<number> {
  const l = await ledgerOf(db, w); await setLedger(db, w, { ...l, credit: l.credit + Math.max(0, Math.floor(amount)) }, now); return l.credit + Math.max(0, Math.floor(amount));
}

/** Owner-only: lend a player `amount` as debt, never past `limit`. */
export async function lend(db: Db, w: Who & { amount: number; limit: number; now?: number }): Promise<{ ok: true; debt: number } | { ok: false; reason: "limit" | "amount"; debt: number }> {
  const l = await ledgerOf(db, w), amount = Math.floor(w.amount);
  if (!(amount > 0)) return { ok: false, reason: "amount", debt: l.debt };
  if (l.debt + amount > w.limit) return { ok: false, reason: "limit", debt: l.debt };
  await setLedger(db, w, { ...l, debt: l.debt + amount }, w.now ?? Date.now());
  return { ok: true, debt: l.debt + amount };
}

/** A frozen player's NPC never uses credit or debt (unless the game says so). */
export const mayBorrow = (frozen: boolean, allowFrozen = false): boolean => !frozen || allowFrozen;

export type Redeem = { ok: true; chips: number; viaCredit: boolean } | { ok: false; reason: "unknown" | "used" | "expired" | "not_yours" | "unpaid" };
/** Back in with a code: it must be theirs, unused, unexpired, and paid, or covered by their credit (`price` is taken from it). */
export async function redeem(db: Db, w: Who & { code: string; price: number; now?: number }): Promise<Redeem> {
  const now = w.now ?? Date.now();
  const r = await db.selectFrom("reentry_codes").selectAll().where("code_hash", "=", hashCode(w.code)).executeTakeFirst();
  if (!r || r.game !== w.game) return { ok: false, reason: "unknown" };
  if (r.user_id !== w.userId) return { ok: false, reason: "not_yours" };
  if (r.used_at) return { ok: false, reason: "used" };
  if (Number(r.valid_until) <= now) return { ok: false, reason: "expired" };
  const l = await ledgerOf(db, w);
  const price = r.price != null ? Number(r.price) : w.price; // the terms the code was issued under
  const viaCredit = !Number(r.paid) && l.credit >= price;
  if (!Number(r.paid) && !viaCredit) return { ok: false, reason: "unpaid" };
  const used = await db.updateTable("reentry_codes").set({ used_at: now }).where("code_hash", "=", r.code_hash).where("used_at", "is", null).executeTakeFirst(); // single use even if asked twice at once
  if (!Number(used.numUpdatedRows ?? 0)) return { ok: false, reason: "used" };
  if (viaCredit) await setLedger(db, w, { ...l, credit: l.credit - price }, now);
  return { ok: true, chips: price, viaCredit };
}

/** Codes that ran out unused and whose owner has not been told yet; they are marked told. */
export async function expiredUntold(db: Db, game: string, thread: string, now = Date.now()): Promise<string[]> {
  const rows = await db.selectFrom("reentry_codes").select(["code_hash", "user_id"]).where("game", "=", game).where("thread", "=", thread).where("used_at", "is", null).where("told_owner", "=", 0).where("valid_until", "<=", now).execute();
  for (const r of rows) await db.updateTable("reentry_codes").set({ told_owner: 1 }).where("code_hash", "=", r.code_hash).execute();
  return rows.map((r) => r.user_id as string);
}

/** Money locked away from the table (and from the NPC that takes a leaving player's seat). It is only ever moved by the player's own /bank and /unbank. */
export async function bankAdd(db: Db, w: Who & { amount: number; min: number; now?: number }): Promise<{ ok: true; banked: number } | { ok: false; reason: "amount" | "min"; min: number }> {
  const amount = Math.floor(w.amount);
  if (!(amount > 0)) return { ok: false, reason: "amount", min: w.min };
  if (amount < w.min) return { ok: false, reason: "min", min: w.min };
  const l = await ledgerOf(db, w);
  await setLedger(db, w, { ...l, banked: l.banked + amount }, w.now ?? Date.now());
  return { ok: true, banked: l.banked + amount };
}
/** Take everything out of the bank; returns what it was. */
export async function bankTake(db: Db, w: Who & { now?: number }): Promise<number> {
  const l = await ledgerOf(db, w);
  if (l.banked > 0) await setLedger(db, w, { ...l, banked: 0 }, w.now ?? Date.now());
  return l.banked;
}

/** Is there a code for this player that has not been used (so the owner may ask for a new one)? */
export async function hasOpenCode(db: Db, w: Who): Promise<boolean> {
  return !!(await db.selectFrom("reentry_codes").select("code_hash").where("game", "=", w.game).where("user_id", "=", w.userId).where("used_at", "is", null).executeTakeFirst());
}
