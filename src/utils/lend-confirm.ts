import crypto from "node:crypto";
import type { Session } from "./types.js";

/**
 * Confirming a loan by remembering what you wrote. The server keeps, for the owner's recent messages, only a hash of a few long words and where each stood (message number,
 * paragraph, sentence, word). To confirm `/lend Bo 300` the owner is asked for the word at one of those places, and answers `/lend confirm aces-baby`. The answer is checked
 * against what was written when it was sent, so editing the message afterwards changes nothing, and the words themselves are never kept. A dash or em dash makes a word long
 * and memorable and hard to guess, so players are told to use one.
 */
const MIN_LEN = 7, KEEP = 40, PER_MESSAGE = 3;
const clean = (w: string): string => w.toLowerCase().replace(/[‐-―−]/g, "-").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const hash = (w: string): string => crypto.createHash("sha256").update(clean(w)).digest("hex").slice(0, 24);

export interface Mark { n: number; p: number; s: number; w: number; h: string }
export interface Pending { target: string; name: string; amount: number; mark: Mark; until: number; tries: number }

/** Remember the long words of a message the owner just wrote. Returns the message number. */
export function remember(session: Session, text: string): number {
  const st = (session.credit ??= { told: {} });
  const n = (st.ownerMsgs = (st.ownerMsgs ?? 0) + 1);
  const found: (Mark & { dash: boolean })[] = [];
  text.split(/\n+/).filter((x) => x.trim()).forEach((para, p) => para.split(/(?<=[.!?])\s+/).forEach((sen, s) => sen.trim().split(/\s+/).forEach((word, w) => {
    const c = clean(word);
    if (c.length >= MIN_LEN && !/[:\[\]]/.test(word)) found.push({ n, p: p + 1, s: s + 1, w: w + 1, h: hash(c), dash: c.includes("-") });
  })));
  found.sort((a, b) => Number(b.dash) - Number(a.dash)); // dashed words first: they are the memorable ones
  const keep = found.slice(0, PER_MESSAGE).map(({ n, p, s, w, h }) => ({ n, p, s, w, h }));
  st.marks = [...(st.marks ?? []), ...keep].slice(-KEEP * PER_MESSAGE);
  return n;
}

/** Pick a place to ask about, never from the message just written. Null when nothing long enough has been written yet. */
export function challenge(session: Session, rng: () => number = Math.random): Mark | null {
  const st = session.credit, last = st?.ownerMsgs ?? 0;
  const pool = (st?.marks ?? []).filter((m) => m.n < last);
  return pool.length ? pool[Math.floor(rng() * pool.length)]! : null;
}
export const ask = (m: Mark): string => `message number ${m.n} you wrote at this table, paragraph ${m.p}, sentence ${m.s}, word ${m.w}`;
export const matches = (m: Mark, answer: string): boolean => hash(answer) === m.h;
