import { CREDIT } from "./config.js";
import { stateDb } from "./db-state.js";
import { MODEL_ID } from "./config.js";
import { issueCode, redeem, lend, ledgerOf, expiredUntold, mayBorrow, bankAdd, bankTake, hasOpenCode } from "./credit.js";
import { challenge, ask, matches } from "./lend-confirm.js";
import { announce } from "./announce.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Session } from "./types.js";

/** The chat side of credit.ts: busts get a code (told only to that player), /reentry, /lend (owner), /credit, and telling the owner when a code ran out. */

const TEXTS: Record<string, string> = {
  no_db: "Credit needs the database, which is not available right now.",
  not_table: "There is no table here to play at.",
  busted: "You are out of chips. Your re-entry code is {code}. It works once and expires in {days} day(s). Use it with /reentry {code} in this private chat once it is paid or you have the credit.",
  expired_owner: "A re-entry code for {name} ran out unused.",
  reentry_usage: "Use /reentry <code>.",
  not_busted: "You are still in the game.",
  welcome_back: "You are back in with {chips} chips.",
  used_credit: " (paid from your credit)",
  unknown: "That code is not known here.", used: "That code was already used.", expired: "That code has expired.", not_yours: "That code is not yours.", unpaid: "That code is not paid yet, and your credit does not cover it.",
  lend_usage: "Use /lend <name> <amount>.", not_owner: "Only the owner can lend.", unknown_who: "I don't know a player called \"{who}\".",
  lent: "{name} was lent {amount}. Their debt is now {debt} of at most {limit}.", over_limit: "That would take {name}'s debt past the limit of {limit} (it is {debt}).", bad_amount: "Give a whole amount above zero.",
  lending_off: "Lending is off (no debt limit is set).", frozen: "{name} is frozen: a frozen player's character does not borrow.",
  balance: "Credit {credit}, debt {debt}, banked {banked}.",
  confirm_needed: "To lend {name} {amount}, confirm it: type /lend confirm <the word> where the word is the one from {where}. (Tip: write a long word with a dash, like aces-baby, in your messages: easy to remember, hard to guess.) This lasts 10 minutes.",
  confirm_none: "To confirm a loan I need something you wrote earlier. Write a message with a long word that has a dash in it (like aces-baby), then ask again.",
  confirm_nothing: "There is no loan waiting for confirmation.", confirm_wrong: "That is not the word. {left} tries left.", confirm_failed: "Too many wrong tries: the loan is cancelled.", confirm_late: "That confirmation ran out of time. Ask for the loan again.",
  bank_hint: "To lock chips away from the table, type the command yourself, for example: /bank {amount}  (later: /unbank), in your private chat.",
  bank_usage: "Use /bank <amount>.", bank_min: "The least you can bank here is {min} (the ante is {ante}).", bank_amount: "Give a whole amount above zero.", bank_poor: "You only have {have} to bank.",
  banked: "{amount} is locked away ({total} banked in all). Nobody at the table can touch it, not even the character that takes your seat.", unbanked: "{amount} is back in front of you.", unbank_none: "You have nothing banked.",
  newcode_usage: "Use /newcode <name>.", newcode_none: "{name} has no unused code to replace.", newcode_done: "A new code for {name}: {code}. The old one no longer works. Give it to them yourself.",
  private_only: "That is private: send it in your private chat with the dealer (open a new chat with this game), never at the table.",
  game_over: "Everyone else has left: the game is over. The ante goes back to {ante}.",
};
const fill = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
const say = (k: string, v: Record<string, string> = {}): string => fill(TEXTS[k] ?? k, v);

const norm = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");
const busted = (state: { actors: Record<string, any> }, actor: string): boolean => !!CREDIT && typeof state.actors[actor]?.[CREDIT.field] === "number" && state.actors[actor][CREDIT.field] <= CREDIT.empty;

/** After a round at a table: every seated player who has just gone bust gets one code (told to them alone), and the owner hears about codes that ran out. */
export async function creditRound(session: Session, key: string, now = Date.now()): Promise<void> {
  const db = stateDb();
  if (!CREDIT || !db || !session.room) return;
  const state = session.snapshots.at(-1)!;
  const flags = (session.credit ??= { told: {} });
  try {
    for (const p of Object.values(session.room.players)) {
      if (!busted(state, p.actor)) { delete flags.told[p.userId]; continue; }
      if (flags.told[p.userId]) continue;
      flags.told[p.userId] = true;
      const code = await issueCode(db, { game: MODEL_ID, userId: p.userId, thread: key, ttlMs: CREDIT.codeTtlMs, now, price: priceNow(state), currency: CREDIT.currency });
      await announce(session, { kind: "bust", to: p.userId, text: say("busted", { code, days: String(Math.round(CREDIT.codeTtlMs / 86_400_000)) }), at: now });
    }
    if (session.owner) for (const uid of await expiredUntold(db, MODEL_ID, key, now)) {
      const name = session.room.players[uid]?.name ?? session.own?.people[uid]?.name ?? uid;
      await announce(session, { kind: "code_expired", to: session.owner.userId, text: say("expired_owner", { name }), at: now });
    }
  } catch (e) { console.warn(`credit: ${(e as Error).message}`); }
}

/** Money and codes are private: at a shared table they are refused, so nothing about them is ever said where everyone reads. */
export const creditPrivateOnly = (): string => say("private_only");

export async function creditCommand(name: "reentry" | "lend" | "credit" | "bank" | "unbank" | "newcode", arg: string, c: { session: Session; key: string; who: PlayerRef; now: number }): Promise<string> {
  const db = stateDb(), s = c.session;
  if (!CREDIT || !db) return say("no_db");
  if (!s.room) return say("not_table");
  const state = s.snapshots.at(-1)!;
  const me = s.room.players[c.who.userId];
  if (name === "credit") { const l = await ledgerOf(db, { game: MODEL_ID, userId: c.who.userId }); return say("balance", { credit: String(l.credit), debt: String(l.debt), banked: String(l.banked) }); }
  if (name === "bank") return bankCommand(db, s, state, c, arg);
  if (name === "unbank") {
    if (!me) return say("not_table");
    const got = await bankTake(db, { game: MODEL_ID, userId: c.who.userId, now: c.now });
    if (!got) return say("unbank_none");
    const a = state.actors[me.actor] as Record<string, unknown> | undefined;
    if (a) a[CREDIT.field] = (typeof a[CREDIT.field] === "number" ? (a[CREDIT.field] as number) : 0) + got;
    return say("unbanked", { amount: String(got) });
  }
  if (name === "newcode") {
    if (!s.owner || s.owner.userId !== c.who.userId) return say("not_owner");
    const nm = arg.trim();
    if (!nm) return say("newcode_usage");
    const hit = Object.values(s.room.players).find((p) => norm(p.name) === norm(nm));
    if (!hit) return say("unknown_who", { who: nm });
    if (!(await hasOpenCode(db, { game: MODEL_ID, userId: hit.userId }))) return say("newcode_none", { name: hit.name });
    const code = await issueCode(db, { game: MODEL_ID, userId: hit.userId, thread: c.key, ttlMs: CREDIT.codeTtlMs, now: c.now, price: priceNow(state), currency: CREDIT.currency });
    return say("newcode_done", { name: hit.name, code }); // shown to the owner alone, in their own reply
  }
  if (name === "reentry") {
    if (!arg.trim()) return say("reentry_usage");
    if (!me || !busted(state, me.actor)) return say("not_busted");
    const r = await redeem(db, { game: MODEL_ID, userId: c.who.userId, code: arg, price: priceNow(state), now: c.now });
    if (!r.ok) return say(r.reason);
    state.actors[me.actor][CREDIT.field] = r.chips;
    if (s.credit) delete s.credit.told[c.who.userId];
    return say("welcome_back", { chips: String(r.chips) }) + (r.viaCredit ? say("used_credit") : "");
  }
  // lend (owner only; a loan waits for /lend confirm <word>)
  if (!s.owner || s.owner.userId !== c.who.userId) return say("not_owner");
  if (!CREDIT.debtLimit) return say("lending_off");
  const st = (s.credit ??= { told: {} });
  const cf = /^confirm\s+(.+)$/i.exec(arg.trim());
  if (cf) {
    const p = st.pending;
    if (!p) return say("confirm_nothing");
    if (c.now > p.until) { delete st.pending; return say("confirm_late"); }
    if (!matches(p.mark, cf[1]!)) { p.tries++; if (p.tries >= 3) { delete st.pending; return say("confirm_failed"); } return say("confirm_wrong", { left: String(3 - p.tries) }); }
    delete st.pending;
    const hit = s.room.players[p.target];
    if (!hit) return say("unknown_who", { who: p.name });
    if (!mayBorrow(!!hit.frozen, CREDIT.frozenBorrow)) return say("frozen", { name: hit.name });
    const r = await lend(db, { game: MODEL_ID, userId: hit.userId, amount: p.amount, limit: CREDIT.debtLimit, now: c.now });
    if (!r.ok) return r.reason === "amount" ? say("bad_amount") : say("over_limit", { name: hit.name, limit: String(CREDIT.debtLimit), debt: String(r.debt) });
    const a = state.actors[hit.actor] as Record<string, unknown> | undefined;
    if (a && typeof a[CREDIT.field] === "number") a[CREDIT.field] = (a[CREDIT.field] as number) + p.amount; // the loan arrives as chips
    return say("lent", { name: hit.name, amount: String(p.amount), debt: String(r.debt), limit: String(CREDIT.debtLimit) });
  }
  const m = /^(.+?)\s+(-?\d+)$/.exec(arg.trim());
  if (!m || !m[1] || !m[2]) return say("lend_usage");
  const hit = Object.values(s.room.players).find((p) => norm(p.name) === norm(m[1]!));
  if (!hit) return say("unknown_who", { who: m[1]! });
  if (!mayBorrow(!!hit.frozen, CREDIT.frozenBorrow)) return say("frozen", { name: hit.name });
  const amount = Number(m[2]);
  if (!(amount > 0)) return say("bad_amount");
  const mark = challenge(s);
  if (!mark) return say("confirm_none");
  st.pending = { target: hit.userId, name: hit.name, amount, mark, until: c.now + 10 * 60_000, tries: 0 };
  return say("confirm_needed", { name: hit.name, amount: String(amount), where: ask(mark) });
}

/** The stack a re-entry is worth now: the table's own (credit.start_from) when it set one, else credit.start. */
const priceNow = (state: any): number => { const v = CREDIT?.startFrom ? Math.floor(Number(at(state, CREDIT.startFrom))) : 0; return v > 0 ? v : CREDIT?.start ?? 200; };
const at = (state: any, path: string): unknown => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), state);

async function bankCommand(db: NonNullable<ReturnType<typeof stateDb>>, s: Session, state: any, c: { who: PlayerRef; now: number }, arg: string): Promise<string> {
  const me = s.room!.players[c.who.userId];
  const CREDIT_ = CREDIT;
  if (!me || !CREDIT_) return say("not_table");
  if (arg.startsWith("~")) return say("bank_hint", { amount: arg.slice(1) });
  const n = Number(arg.replace(/[,$\s]/g, ""));
  if (!arg.trim()) return say("bank_usage");
  if (!(Math.floor(n) > 0)) return say("bank_amount");
  const ante = Number(at(state, CREDIT_.ante)) || 0, min = Math.max(1, CREDIT_.minAntes * ante);
  const a = state.actors[me.actor] as Record<string, unknown> | undefined;
  const have = typeof a?.[CREDIT_.field] === "number" ? (a![CREDIT_.field] as number) : 0;
  if (Math.floor(n) < min) return say("bank_min", { min: String(min), ante: String(ante || "not set") });
  if (Math.floor(n) > have) return say("bank_poor", { have: String(have) });
  const r = await bankAdd(db, { game: MODEL_ID, userId: c.who.userId, amount: n, min, now: c.now });
  if (!r.ok) return say(r.reason === "min" ? "bank_min" : "bank_amount", { min: String(min), ante: String(ante) });
  a![CREDIT_.field] = have - Math.floor(n);
  return say("banked", { amount: String(Math.floor(n)), total: String(r.banked) });
}

/** After a round: the first ante is kept as the starting one; when the table is down to one player the game is over and the ante goes back to it. Code, not the narrator. */
export function anteRound(session: Session): string | null {
  if (!CREDIT || !CREDIT.gameOver) return null;
  const state = session.snapshots.at(-1)!;
  const g = state.game as Record<string, unknown>;
  const path = CREDIT.ante.replace(/^game\./, "");
  const ante = Number(g[path]) || 0;
  if (ante > 0 && g.ante_start === undefined) g.ante_start = ante;
  if (g.reset_start === undefined && Number(g.hand) > 0 && Object.values(CREDIT.reset).includes("start")) g.reset_start = Object.fromEntries(Object.keys(CREDIT.reset).map((k) => [k.slice(5), g[k.slice(5)] ?? null])); // what the table registered, at its first hand
  if (g.ante_start === undefined || g.phase === "registration" || !(Number(g.hand) > 0)) return null;
  const { field, empty } = CREDIT;
  const inPlay = Object.values(state.actors).filter((a: any) => typeof a?.[field] === "number" && a[field] > empty).length;
  if (inPlay > 1) return null;
  g[path] = g.ante_start; g.phase = "registration"; g.hand = 0;
  for (const [k, v] of Object.entries(CREDIT.reset)) { const f = k.slice(5), to = v === "start" ? ((g.reset_start as Record<string, unknown> | undefined)?.[f] ?? null) : v; if (to === null) delete g[f]; else g[f] = to; }
  return say("game_over", { ante: String(g.ante_start) });
}
