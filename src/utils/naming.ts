import { judgeJSON } from "./judge.js";
import { NAMING } from "./config.js";
import type { GameState } from "./types.js";

/**
 * The naming call: the narrator never invents a name. A character that arrives without one (an NPC contestant, a new guest) is named by a separate small
 * call, and code checks the answer: one clean word, not already used, and not alike in sound or first letters to a used one (no Kristen next to a
 * Christian). A bad answer is asked for again; after `tries` the code picks from its own list, so naming never fails and never stalls a turn.
 */
export const DEFAULT_PROMPT = "Choose a first name for a new character. It must not be any of: {used}. A common or unique English name that is easy to say aloud and sounds clearly different from every name in that list. Reply ONLY JSON: {\"name\": \"...\"}.";
const FALLBACK = ["Marcus", "Priya", "Tobias", "Lena", "Omar", "Sadie", "Felix", "Nora", "Dmitri", "Hazel", "Ravi", "Greta", "Ezra", "Mina", "Walt", "Ingrid", "Jasper", "Pilar", "Otis", "Wren"];

/** A rough sound key: c, ch, q and k all sound the same, vowels after the first letter are dropped, doubled letters collapse. */
export function soundKey(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z]/g, "").replace(/ph/g, "f").replace(/ch/g, "k").replace(/[cq]/g, "k").replace(/z/g, "s").replace(/y/g, "i").replace(/(.)\1+/g, "$1");
  return s.slice(0, 1) + s.slice(1).replace(/[aeiou]/g, "");
}
const lev = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
};
/** Alike enough to be confused when read aloud: the same first two letters, the same sound key, or keys one edit apart. */
export function alike(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x === y || (x.length >= 2 && y.length >= 2 && x.slice(0, 2) === y.slice(0, 2))) return true;
  const kx = soundKey(a), ky = soundKey(b);
  return kx === ky || (kx.length >= 4 && ky.length >= 4 && lev(kx, ky) <= 1);
}
export const clean = (v: unknown): string | null => { const s = typeof v === "string" ? v.trim() : ""; return s.length <= 20 && /^[A-Z][a-z]+(?:[-'][A-Za-z]+)?$/.test(s) ? s : null; };
const fine = (n: string, used: string[]): boolean => !used.some((u) => alike(n, u));

/** One name that is clean, unused and unlike the used ones. `ask` gets the used list; a failing or stubborn model falls through to the code's own list. */
export async function chooseName(used: string[], ask: (used: string[]) => Promise<unknown>, tries = 3): Promise<string> {
  for (let i = 0; i < tries; i++) {
    try { const n = clean(await ask(used)); if (n && fine(n, used)) return n; } catch { /* ask again */ }
  }
  return FALLBACK.find((n) => fine(n, used)) ?? `${FALLBACK[used.length % FALLBACK.length]}${used.length + 2}`;
}

const modelAsk = (prompt: string) => async (used: string[]): Promise<unknown> => {
  const v = await judgeJSON(prompt.replace(/\{used\}/g, used.length ? used.join(", ") : "(none yet)"), "Name the new character.", "naming", 60);
  return v?.name;
};

/** Give every actor that has no name one (never the user). Mutates and returns the state. Never throws. */
export async function nameActors(state: GameState, ask?: (used: string[]) => Promise<unknown>): Promise<GameState> {
  if (!NAMING) return state;
  const used = Object.values(state.actors).map((a) => (typeof a?.name === "string" ? a.name : "")).filter(Boolean);
  for (const [id, a] of Object.entries(state.actors)) {
    if (!a || a.controlled_by !== "npc" || typeof a.name === "string" && a.name.trim()) continue;
    if (NAMING.skip.includes(id) || (NAMING.role && NAMING.roles.length && !NAMING.roles.includes(String(a[NAMING.role] ?? "")))) continue;
    const n = await chooseName(used, ask ?? modelAsk(NAMING.prompt || DEFAULT_PROMPT));
    a.name = n; used.push(n);
    console.log(`naming: ${id} is now ${n.length ? "named" : "unnamed"}`);
  }
  return state;
}

const nameOf = (state: GameState): string[] => Object.values(state.actors).map((a) => (typeof a?.name === "string" ? a.name : "")).filter(Boolean);

/** Keep `pool` reserved names ready: clean, unused, unlike each other and unlike every name in play. Drops reserved names that have been taken. Never throws. */
export async function refillPool(session: { namePool?: string[] }, state: GameState, ask?: (used: string[]) => Promise<unknown>): Promise<string[]> {
  if (!NAMING || NAMING.pool < 1) return [];
  const inPlay = nameOf(state);
  const pool = (session.namePool ?? []).filter((n) => !inPlay.some((u) => u.toLowerCase() === n.toLowerCase()));
  while (pool.length < NAMING.pool) pool.push(await chooseName([...inPlay, ...pool], ask ?? modelAsk(NAMING.prompt || DEFAULT_PROMPT)));
  session.namePool = pool;
  return pool;
}

/** What the narrator is told about the reserved names. */
export const poolBlock = (pool: string[]): string => pool.length
  ? `\n\n## NAMES FOR NEW CHARACTERS (reserved by the server)\nNever invent a name. Any new contestant or guest you introduce gets the next unused name from this list, in order: ${pool.join(", ")}.`
  : "";
