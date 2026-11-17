import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { openDb } from "../src/utils/db.js";
import { migrateUp } from "../src/utils/db-migrations.js";
import { expectedStamp } from "../src/utils/db-state.js";
import { bankAdd, bankTake, hasOpenCode, issueCode, markPaid, markPaidChecked, redeem, lend, addCredit, ledgerOf, expiredUntold, mayBorrow, hashCode } from "../src/utils/credit.js";

let db: Awaited<ReturnType<typeof openDb>>;
const w = { game: "g", userId: "u1" };
beforeEach(async () => { db = await openDb("sqlite::memory:"); await migrateUp(db, expectedStamp()); });
afterEach(async () => { await db.destroy(); });
const DAY = 86_400_000;

describe("re-entry codes", () => {
  it("keeps only the hash; a code needs payment or credit, is single use, is theirs, and expires", async () => {
    const code = await issueCode(db, { ...w, thread: "t", ttlMs: 7 * DAY, now: 1000 });
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(JSON.stringify(await db.selectFrom("reentry_codes").selectAll().execute())).not.toContain(code);
    expect(await redeem(db, { ...w, code, price: 200, now: 2000 })).toEqual({ ok: false, reason: "unpaid" });
    expect(await redeem(db, { game: "g", userId: "u2", code, price: 200, now: 2000 })).toEqual({ ok: false, reason: "not_yours" });
    expect(await markPaid(db, code.toLowerCase().replace("-", " "))).toBe(true); // forgiving about case and the dash
    expect(await redeem(db, { ...w, code, price: 200, now: 2000 })).toEqual({ ok: true, chips: 200, viaCredit: false });
    expect(await redeem(db, { ...w, code, price: 200, now: 2001 })).toEqual({ ok: false, reason: "used" });
    expect(await redeem(db, { ...w, code: "AAAA-BBBB", price: 200 })).toEqual({ ok: false, reason: "unknown" });
  });
  it("enough credit pays for it, and is spent", async () => {
    const code = await issueCode(db, { ...w, thread: "t", ttlMs: DAY, now: 1000 });
    await addCredit(db, w, 150, 1000);
    expect((await redeem(db, { ...w, code, price: 200, now: 1500 })).ok).toBe(false);
    await addCredit(db, w, 100, 1000);
    expect(await redeem(db, { ...w, code, price: 200, now: 1500 })).toEqual({ ok: true, chips: 200, viaCredit: true });
    expect((await ledgerOf(db, w)).credit).toBe(50);
  });
  it("an expired code fails, and the owner is told once, the row staying long enough for that", async () => {
    const code = await issueCode(db, { ...w, thread: "t", ttlMs: DAY, now: 1000 });
    await markPaid(db, code);
    expect(await redeem(db, { ...w, code, price: 1, now: 1000 + 2 * DAY })).toEqual({ ok: false, reason: "expired" });
    expect(await expiredUntold(db, "g", "t", 1000 + 2 * DAY)).toEqual(["u1"]);
    expect(await expiredUntold(db, "g", "t", 1000 + 3 * DAY)).toEqual([]);
  });
  it("a new code replaces the old unused one", async () => {
    const a = await issueCode(db, { ...w, thread: "t", ttlMs: DAY, now: 1 }), b = await issueCode(db, { ...w, thread: "t", ttlMs: DAY, now: 2 });
    expect(await db.selectFrom("reentry_codes").select("code_hash").execute()).toEqual([{ code_hash: hashCode(b) }]);
    expect(a).not.toBe(b);
  });
});

describe("lending", () => {
  it("owner lends as debt up to the limit, never past it", async () => {
    expect(await lend(db, { ...w, amount: 300, limit: 500 })).toEqual({ ok: true, debt: 300 });
    expect(await lend(db, { ...w, amount: 300, limit: 500 })).toEqual({ ok: false, reason: "limit", debt: 300 });
    expect(await lend(db, { ...w, amount: 0, limit: 500 })).toMatchObject({ ok: false, reason: "amount" });
    expect(await lend(db, { ...w, amount: 200, limit: 500 })).toEqual({ ok: true, debt: 500 });
  });
  it("a frozen player's NPC never borrows unless the game allows it", () => {
    expect(mayBorrow(true)).toBe(false); expect(mayBorrow(false)).toBe(true); expect(mayBorrow(true, true)).toBe(true);
  });
});

describe("banking and new codes", () => {
  it("banked chips need the minimum, add up, and come out in one go", async () => {
    expect(await bankAdd(db, { ...w, amount: 100, min: 200 })).toEqual({ ok: false, reason: "min", min: 200 });
    expect(await bankAdd(db, { ...w, amount: 0, min: 1 })).toMatchObject({ ok: false, reason: "amount" });
    expect(await bankAdd(db, { ...w, amount: 4000, min: 200 })).toEqual({ ok: true, banked: 4000 });
    expect(await bankAdd(db, { ...w, amount: 500, min: 200 })).toEqual({ ok: true, banked: 4500 });
    expect((await ledgerOf(db, w)).banked).toBe(4500);
    expect(await bankTake(db, w)).toBe(4500); expect(await bankTake(db, w)).toBe(0);
  });
  it("an unused code can be asked for again, a used one cannot", async () => {
    expect(await hasOpenCode(db, w)).toBe(false);
    const c = await issueCode(db, { ...w, thread: "t", ttlMs: DAY, now: 1 });
    expect(await hasOpenCode(db, w)).toBe(true);
    await markPaid(db, c); await redeem(db, { ...w, code: c, price: 1, now: 2 });
    expect(await hasOpenCode(db, w)).toBe(false);
  });
});

describe("the terms a code was issued under", () => {
  it("a payment that names another currency or amount is refused, and the chips are what the table registered, not what the payment service says", async () => {
    const code = await issueCode(db, { ...w, thread: "t", ttlMs: 7 * DAY, now: 1000, price: 500, currency: "chips" });
    expect(await markPaidChecked(db, code, { amount: 500, currency: "usd" })).toEqual({ ok: false, reason: "terms" });
    expect(await markPaidChecked(db, code, { amount: 50, currency: "chips" })).toEqual({ ok: false, reason: "terms" });
    expect(await markPaidChecked(db, code, { require: true })).toEqual({ ok: false, reason: "terms" });
    expect(await markPaidChecked(db, "NOPE-NOPE", {})).toEqual({ ok: false, reason: "unknown" });
    expect(await redeem(db, { ...w, code, price: 200, now: 2000 })).toEqual({ ok: false, reason: "unpaid" });
    expect(await markPaidChecked(db, code, { amount: 500, currency: "chips" })).toEqual({ ok: true });
    expect(await redeem(db, { ...w, code, price: 200, now: 2000 })).toMatchObject({ ok: true, chips: 500 });
  });
  it("a code from before the terms were kept still works on the configured price, and a plain payment still passes unless terms are required", async () => {
    const code = await issueCode(db, { ...w, thread: "t", ttlMs: 7 * DAY, now: 1000 });
    expect(await markPaidChecked(db, code, {})).toEqual({ ok: true });
    expect(await redeem(db, { ...w, code, price: 200, now: 2000 })).toMatchObject({ ok: true, chips: 200 });
  });
});
