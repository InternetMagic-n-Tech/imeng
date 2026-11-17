import crypto from "node:crypto";
import { PII_FILTER, type Category } from "./pii-filter-config.js";

/**
 * Keeps personal details out of every model, log and trace by working on the player's messages at the door, in code (no model reads them first).
 * Each detected value becomes a stable token such as [email:3fa9c2] (the same value gives the same token on every request, so the replayed history stays
 * consistent and nothing needs storing). The token is a salted hash (env PII_SALT: set it); the original is never kept. Built-in kinds: email, phone, card
 * (Luhn), id_number (SSN, SIN, IBAN), ip, secret (a password or token in a URL or key=value). config.json `patterns` adds game-specific ones.
 */

const SALT = process.env.PII_SALT || "pii";
export const token = (kind: string, value: string): string => `[${kind}:${crypto.createHmac("sha256", SALT).update(value.toLowerCase()).digest("hex").slice(0, 6)}]`;

const luhn = (digits: string): boolean => {
  let sum = 0;
  [...digits].reverse().forEach((c, i) => { let n = Number(c); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; });
  return digits.length > 0 && sum % 10 === 0;
};
const digitsOf = (s: string): string => s.replace(/\D/g, "");

interface Rule { kind: string; regex: RegExp; ok?: (m: string) => boolean }
const BUILTIN: Record<Category, Rule[]> = {
  email: [{ kind: "email", regex: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi }],
  secret: [{ kind: "secret", regex: /\b(?:[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@\S+/gi }, { kind: "secret", regex: /(?<![\[\w])(?:api[_-]?key|token|password|passwd|secret)\s*[=:]\s*[^\s&,;]{6,}/gi }],
  card: [{ kind: "card", regex: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, ok: (m) => { const d = digitsOf(m); return d.length >= 13 && d.length <= 19 && luhn(d); } }],
  id_number: [
    { kind: "id_number", regex: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
    { kind: "id_number", regex: /(?<!\d)\d{3}[ -]\d{3}[ -]\d{3}(?!\d)/g, ok: (m) => luhn(digitsOf(m)) },
    { kind: "id_number", regex: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  ],
  phone: [{ kind: "phone", regex: /(?<![\d.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?![\d.])/g, ok: (m) => digitsOf(m).length >= 10 && digitsOf(m).length <= 13 }],
  ip: [{ kind: "ip", regex: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g }],
};
// Order matters: the more specific kinds go first, so a card number is not also read as a phone number.
const ORDER: Category[] = ["secret", "email", "card", "id_number", "phone", "ip"];

export interface Scrubbed { text: string; found: Record<string, number> }

/** Replace every personal detail in `text` with its token (or only count them when the game says `allow`). */
export function scrubText(text: string): Scrubbed { return PII_FILTER ? scrubWith(text, PII_FILTER) : { text, found: {} }; }

/** The built-in kinds, always on, for what is written to the debug output (whatever the game's own pii_filter says). */
const LOG_CFG = { names: false, newClass: false, classes: [] as never[], mappings: [] as never[], restore: false, placeholders: { secret: "[SECRET]" } as Record<string, string>, detect: [...ORDER] as Category[], onDetect: "mask" as const, allow: [] as string[], patterns: [] as { name: string; regex: RegExp }[], texts: {} };
export const scrubForLog = (text: string): string => scrubWith(text, PII_FILTER ? { ...PII_FILTER, detect: [...new Set([...PII_FILTER.detect, ...ORDER])], onDetect: "mask" } : LOG_CFG).text;

function scrubWith(text: string, cfg: NonNullable<typeof PII_FILTER>): Scrubbed {
  if (!text) return { text, found: {} };
  const found: Record<string, number> = {};
  const rules: Rule[] = [...ORDER.filter((c) => cfg.detect.includes(c)).flatMap((c) => BUILTIN[c]), ...cfg.patterns.map((p) => ({ kind: p.name, regex: p.regex }))];
  let out = text;
  for (const r of rules) {
    out = out.replace(new RegExp(r.regex.source, r.regex.flags), (m) => {
      if (r.ok && !r.ok(m)) return m;
      if (cfg.allow.includes(m.toLowerCase())) return m;
      found[r.kind] = (found[r.kind] ?? 0) + 1;
      return cfg.onDetect === "allow" ? m : cfg.placeholders[r.kind] ?? token(r.kind, m);
    });
  }
  return { text: out, found };
}

type Msg = { role?: string; content?: unknown; [k: string]: unknown };

/** The player's messages with personal details tokenised: text content, and the text parts of a multi-part content. The game's own system messages are left alone. */
export function scrubMessages<T extends Msg>(messages: T[]): { messages: T[]; found: Record<string, number> } {
  const total: Record<string, number> = {};
  const add = (f: Record<string, number>): void => { for (const [k, n] of Object.entries(f)) total[k] = (total[k] ?? 0) + n; };
  const out = messages.map((m) => {
    if (m.role === "system") return m;
    if (typeof m.content === "string") { const r = scrubText(m.content); add(r.found); return r.text === m.content ? m : { ...m, content: r.text }; }
    if (Array.isArray(m.content)) {
      return { ...m, content: m.content.map((p: any) => { if (p && typeof p.text === "string") { const r = scrubText(p.text); add(r.found); return r.text === p.text ? p : { ...p, text: r.text }; } return p; }) };
    }
    return m;
  });
  return { messages: out as T[], found: total };
}

export const summary = (found: Record<string, number>): string => Object.entries(found).map(([k, n]) => `${k} ${n}`).join(", ");
