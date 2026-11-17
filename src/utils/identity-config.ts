import { config } from "./config.js";
import { parseDurationMs } from "./durations.js";

/** config.json `link` and `freeze` (each off unless its block exists). */

const num = (v: unknown, d: number, lo: number, hi: number): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const lk: any = config.link && typeof config.link === "object" ? config.link : null;
export const LINK = lk ? {
  length: num(lk.length, 8, 4, 16),
  style: (lk.style === "words" ? "words" : "chars") as "chars" | "words",
  words: Array.isArray(lk.words) ? (lk.words as unknown[]).filter((w): w is string => typeof w === "string" && /^[^\s-]+$/.test(w)) : [],
  ttlMs: parseDurationMs(lk.ttl ?? "10m") ?? 600_000,
  maxFails: num(lk.max_fails, 5, 1, 50),
  texts: (lk.texts && typeof lk.texts === "object" ? lk.texts : {}) as Record<string, string>,
} : null;

const fz: any = config.freeze && typeof config.freeze === "object" ? config.freeze : null;
export const FREEZE = fz ? {
  mode: (["npc", "inert"].includes(fz.mode) ? fz.mode : "skip") as "skip" | "npc" | "inert",
  catchUp: (fz.catch_up === "public" ? "public" : "none") as "none" | "public",
  catchChars: num(fz.catch_up_chars, 1500, 100, 8000),
  others: (fz.others === "anyone" ? "anyone" : "off") as "off" | "anyone",
  text: typeof fz.text === "string" ? fz.text : "",
  texts: (fz.texts && typeof fz.texts === "object" ? fz.texts : {}) as Record<string, string>,
} : null;

const LINK_TEXTS: Record<string, string> = {
  code: "Your link code is {code}. In your other app send /link {code} within {minutes} min. Anyone who sees it can use it once, so do not post it in a channel.",
  dm_sent: "I sent you a link code in a direct message.",
  linked: "Linked: this account and {name} are now the same player.",
  already: "These accounts are already linked.",
  bad_code: "That code is not valid or has expired.",
  locked: "Too many wrong codes. Try again later.",
};
const FREEZE_TEXTS: Record<string, string> = {
  frozen: "{who} is frozen.",
  unfrozen: "{who} is back.",
  you_are_frozen: "You are frozen. Send /unfreeze to come back.",
  nobody: "There is nobody to freeze here.",
  not_allowed: "You can only freeze yourself.",
  unknown_who: "I don't know who \"{who}\" is.",
  solo: "There is no table here; freeze needs a shared game.",
  not_frozen: "{who} is not frozen.",
  catch_up: "While you were away:\n\n{story}",
};
const fill = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
export const linkText = (key: string, v: Record<string, string> = {}): string => fill(LINK?.texts[key] ?? LINK_TEXTS[key] ?? key, v);
export const freezeText = (key: string, v: Record<string, string> = {}): string => fill(FREEZE?.texts[key] ?? FREEZE_TEXTS[key] ?? key, v);
