import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SAVE_DIR, SESSION_PREFIX } from "./config.js";
import { PERSIST } from "./cli.js";
import { redisClient } from "./logger.js";
import { LINK, linkText } from "./identity-config.js";
import { seats, seat } from "./seats.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Room } from "./types.js";

/**
 * One person, several accounts. Open WebUI and Discord give the same human different ids (an Open WebUI uuid, `discord:<id>`); /link joins them
 * so seats, tables and characters follow the person. A code is made by /link, shown only to its owner (a Discord DM; in Open WebUI as a note that
 * never reaches the game), and redeemed once by `/link <code>` in the other app. Codes live in memory only. The links are saved like seats
 * (SAVE_DIR/links.json and, with Redis, the hash `<SESSION_PREFIX>:links`).
 */

/** Account id -> the id of the person it belongs to (the root). An account with no entry is its own person. */
export const links = new Map<string, string>();
const HASH = `${SESSION_PREFIX}:links`;
const file = (): string => path.join(SAVE_DIR, "links.json");
let loaded: Promise<void> | null = null;

/** No O, I or L (and no 0 or 1): codes are read aloud and typed by hand. */
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const canonical = (userId: string): string => links.get(userId) ?? userId;
export const canonicalPlayer = (p: PlayerRef): PlayerRef => (LINK ? { ...p, userId: canonical(p.userId) } : p);
/** Every account that belongs to this person (their root and everything linked to it). */
export const accountsOf = (userId: string): string[] => { const root = canonical(userId); return [root, ...[...links].filter(([, r]) => r === root).map(([a]) => a)]; };

function saveFile(): void {
  if (!PERSIST) return;
  try { fs.mkdirSync(SAVE_DIR, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(links))); }
  catch (e) { console.warn("could not save links:", (e as Error).message); }
}

export function loadLinks(): Promise<void> {
  loaded ??= (async () => {
    if (PERSIST) { try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file(), "utf8")))) if (typeof v === "string") links.set(k, v); } catch { /* none yet */ } }
    const r = redisClient();
    if (r?.isReady) { try { for (const [k, v] of Object.entries(await r.hGetAll(HASH))) links.set(k, v); } catch (e) { console.warn("could not read links from redis:", (e as Error).message); } }
  })();
  return loaded;
}

async function persist(entries: [string, string][]): Promise<void> {
  saveFile();
  const r = redisClient();
  if (r?.isReady) { try { for (const [k, v] of entries) await r.hSet(HASH, k, v); } catch (e) { console.warn("could not save links to redis:", (e as Error).message); } }
}

/** Join two accounts into one person. The root of `owner` becomes the root of both. */
export async function linkAccounts(owner: string, other: string): Promise<boolean> {
  const root = canonical(owner), from = canonical(other);
  if (root === from) return false;
  const changed: [string, string][] = [];
  for (const a of accountsOf(from)) { links.set(a, root); changed.push([a, root]); }
  await persist(changed);
  for (const [a] of changed) { const st = seats.get(a); if (st && !seats.has(root)) await seat(root, st.table, st.at); } // the seat follows the person
  return true;
}

// ---------- codes ----------

interface Pending { userId: string; name: string; expires: number }
const codes = new Map<string, Pending>();
const fails = new Map<string, { n: number; since: number }>();
export const _resetIdentity = (): void => { links.clear(); codes.clear(); fails.clear(); loaded = null; };

export type Rand = (n: number) => number;
const defaultRand: Rand = (n) => crypto.randomInt(n);

export function makeCode(rand: Rand = defaultRand): string {
  if (!LINK) throw new Error("link is off");
  if (LINK.style === "words" && LINK.words.length >= 16) return [0, 1, 2].map(() => LINK!.words[rand(LINK!.words.length)]).join("-");
  return Array.from({ length: LINK.length }, () => ALPHABET[rand(ALPHABET.length)]).join("");
}
const norm = (c: string): string => c.trim().toLowerCase();

export function issueCode(who: PlayerRef, now: number, rand?: Rand): string {
  for (const [c, p] of codes) if (p.expires <= now || p.userId === who.userId) codes.delete(c);
  let code = makeCode(rand);
  for (let i = 0; codes.has(norm(code)) && i < 20; i++) code = makeCode(rand);
  codes.set(norm(code), { userId: who.userId, name: who.name, expires: now + LINK!.ttlMs });
  return code;
}

export type Redeemed = { ok: true; name: string; already: boolean } | { ok: false; reason: "bad" | "locked" };

export async function redeemCode(code: string, who: PlayerRef, now: number): Promise<Redeemed> {
  const f = fails.get(who.userId);
  if (f && now - f.since > LINK!.ttlMs) fails.delete(who.userId);
  if ((fails.get(who.userId)?.n ?? 0) >= LINK!.maxFails) return { ok: false, reason: "locked" };
  const p = codes.get(norm(code));
  if (!p || p.expires <= now) {
    const cur = fails.get(who.userId);
    fails.set(who.userId, { n: (cur?.n ?? 0) + 1, since: cur?.since ?? now });
    return { ok: false, reason: "bad" };
  }
  codes.delete(norm(code));
  const joined = await linkAccounts(p.userId, who.userId);
  return { ok: true, name: p.name, already: !joined };
}

/** What to answer to `/link` or `/link <code>`: the public text, and (Discord) a private one the bridge sends as a direct message. */
export async function linkTurn(arg: string, who: PlayerRef, now: number, rand?: Rand): Promise<string> {
  if (!arg.trim()) {
    const code = issueCode(who, now, rand);
    const minutes = String(Math.max(1, Math.round(LINK!.ttlMs / 60000)));
    const text = linkText("code", { code, minutes });
    return who.userId.startsWith("discord:") ? `${linkText("dm_sent")}<dm>${text}</dm>` : text; // the bridge turns <dm> into a direct message
  }
  const r = await redeemCode(arg, who, now);
  if (!r.ok) return linkText(r.reason === "locked" ? "locked" : "bad_code");
  return linkText(r.already ? "already" : "linked", { name: r.name });
}

/** After a link: a player who was recorded under another of the person's accounts is the same player. Their actor, seat and lines stay as they were. */
export function rekeyRoom(room: Room): void {
  const swap = (id: string): string => canonical(id);
  for (const id of [...room.order]) {
    const c = swap(id);
    if (c === id) continue;
    const p = room.players[id];
    if (room.players[c]) { room.order = room.order.filter((x) => x !== id); delete room.players[id]; } // both were already at the table: the earlier one stays
    else { room.players[c] = { ...p, userId: c }; delete room.players[id]; room.order = room.order.map((x) => (x === id ? c : x)); }
  }
  for (const t of room.talk) t.userId = swap(t.userId);
  for (const n of room.notes) n.userId = swap(n.userId);
  room.confirmed = [...new Set(room.confirmed.map(swap))];
  if (room.awaiting) room.awaiting = [...new Set(room.awaiting.map(swap))];
}
