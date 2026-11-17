import { ID_DOMAINS, REFS } from "./config.js";
import { mintId } from "./ids.js";
import { norm } from "./text.js";
import type { GameState, IdDomain, RefRule } from "./types.js";

/**
 * Id domains and references (config.json: id_domains, refs): where entities with ids live, how their ids are made, and which
 * fields must point at them. Pure state logic; matching a name to an id is the judge's job (utils/refs.ts).
 */

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** An id never contains a dot (paths are split on dots), whitespace, quotes or slashes, and has no padding. */
export const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 100 && id === id.trim() && !/[.\s/\\'"\u0000-\u001f]/.test(id) && !UNSAFE.has(id) && !(id in Object.prototype);

/** A name made into a usable id: "Rusty Key!" -> "rusty_key". */
export const slug = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60);

const walk = (state: unknown, path: string[]): any => {
  let cur: any = state;
  for (const k of path) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
};

export const domainOf = (name: string): IdDomain | undefined => ID_DOMAINS[name];
export const domainPath = (d: IdDomain): string => d.at.join(".");
export const nonActorDomains = (): IdDomain[] => Object.values(ID_DOMAINS).filter((d) => d.name !== "actors");

export function idsOf(state: GameState, d: IdDomain): string[] {
  const c = walk(state, d.at);
  if (Array.isArray(c)) return d.key ? c.map((e) => e?.[d.key!]).filter((x): x is string => typeof x === "string") : [];
  return c && typeof c === "object" ? Object.keys(c) : [];
}
export const hasId = (state: GameState, d: IdDomain, id: string): boolean => idsOf(state, d).includes(id);

/** The entry with this id (an object), or undefined. */
export function entryOf(state: GameState, d: IdDomain, id: string): Record<string, any> | undefined {
  const c = walk(state, d.at);
  if (Array.isArray(c)) return d.key ? c.find((e) => e?.[d.key!] === id) : undefined;
  return c && typeof c === "object" && Object.hasOwn(c, id) ? c[id] : undefined;
}

/**
 * The id a value stands for: the bare id, "<container>.<id>" (e.g. "actors.user"), or the id in another case. Never a name.
 * Returns null when it is not one.
 */
export function idFrom(state: GameState, d: IdDomain, value: unknown): string | null {
  if (typeof value !== "string") return null;
  let raw = value.trim();
  const prefix = domainPath(d) + ".";
  if (raw.toLowerCase().startsWith(prefix.toLowerCase())) raw = raw.slice(prefix.length);
  if (!raw) return null;
  const ids = idsOf(state, d);
  if (ids.includes(raw)) return raw;
  const hits = ids.filter((id) => norm(id) === norm(raw));
  return hits.length === 1 ? hits[0] : null;
}

// ---------- making and removing entries ----------

/** The id a new entry gets (nothing is changed). `hint`: an id the model proposed. Throws when there is no usable id. */
export function newIdFor(state: GameState, d: IdDomain, fields: Record<string, unknown>, hint?: unknown): string {
  const ids = idsOf(state, d);
  const usable = (id: string): boolean => validId(id) && !ids.includes(id);
  if (!d.mint) { // the id is the one asked for (refused if it cannot be used), or the name as a slug when none was asked for
    const id = hint === undefined || hint === null || hint === "" ? slug(fields[d.from]) : String(hint);
    if (!usable(id)) throw new Error(`bad/duplicate ${d.name === "actors" ? "actor" : "id"}`);
    return id;
  }
  const natural = validId(hint) ? hint : slug(fields[d.from]);
  if (d.when === "collision" && usable(natural)) return natural;
  return mintId(d.mint, { fields, from: d.from, ids });
}

function ensureContainer(state: GameState, d: IdDomain): Record<string, any> | any[] {
  let c = walk(state, d.at);
  if (c === undefined) { c = d.key ? [] : {}; (state as any)[d.at[0]][d.at[1]] = c; }
  if (typeof c !== "object" || c === null || Array.isArray(c) !== !!d.key) throw new Error(`${domainPath(d)} is not a ${d.key ? "list" : "map"}`);
  return c;
}

/** Put a new entry in its container under `id` (the id field of an array entry is set here). */
export function placeEntry(state: GameState, d: IdDomain, id: string, value: Record<string, unknown>): void {
  const c = ensureContainer(state, d);
  if (Array.isArray(c)) c.push({ ...value, [d.key!]: id }); else c[id] = value;
}

/** Remove an entry and clear every reference to it. */
export function dropEntry(state: GameState, d: IdDomain, id: string): void {
  const c = walk(state, d.at);
  if (Array.isArray(c)) { const i = c.findIndex((e) => e?.[d.key!] === id); if (i < 0) throw new Error(`no such ${d.name} entry ${id}`); c.splice(i, 1); }
  else if (c && typeof c === "object" && Object.hasOwn(c, id)) delete c[id];
  else throw new Error(`no such ${d.name} entry ${id}`);
  clearRefsTo(state, d.name, id);
}

// ---------- references ----------

const matches = (pattern: string[], parts: string[]): boolean => parts.length >= pattern.length && pattern.every((p, i) => p === "*" || p === parts[i]);

/** The reference rule that governs a path, and what follows the rule's own path (a map key, for keys_to). */
export function matchRef(path: string): { rule: RefRule; rest: string[] } | null {
  const parts = path.split(".");
  for (const rule of REFS) if (matches(rule.pattern, parts)) return { rule, rest: parts.slice(rule.pattern.length) };
  return null;
}

function* fieldsOf(cur: any, pattern: string[], i = 0): Generator<[any, string]> {
  if (cur === null || typeof cur !== "object") return;
  const seg = pattern[i];
  const keys = seg === "*" ? Object.keys(cur) : Object.hasOwn(cur, seg) ? [seg] : [];
  for (const k of keys) {
    if (i === pattern.length - 1) yield [cur, k];
    else yield* fieldsOf(cur[k], pattern, i + 1);
  }
}

const refsTo = (domain: string): RefRule[] => REFS.filter((r) => r.to === domain || r.keysTo === domain);

/** An entry left: every field that held its id is cleared (a scalar becomes null, the id leaves arrays and maps). */
export function clearRefsTo(state: GameState, domain: string, id: string | null): void {
  for (const rule of refsTo(domain)) {
    for (const [o, k] of [...fieldsOf(state, rule.pattern)]) {
      const v = o[k];
      if (rule.keysTo) { if (v && typeof v === "object") { if (id === null) o[k] = {}; else delete v[id]; } }
      else if (Array.isArray(v)) o[k] = id === null ? [] : v.filter((x) => x !== id);
      else if (id === null || v === id) o[k] = null;
    }
  }
}

/** An entry's id changed: the entry moves to its new id and every reference follows. */
export function renameId(state: GameState, d: IdDomain, from: string, to: string): void {
  const c = walk(state, d.at);
  if (Array.isArray(c)) { const e = c.find((x) => x?.[d.key!] === from); if (e) e[d.key!] = to; }
  else if (c && Object.hasOwn(c, from)) { const entries = Object.entries(c).map(([k, v]) => [k === from ? to : k, v] as const); for (const k of Object.keys(c)) delete c[k]; for (const [k, v] of entries) c[k] = v; }
  for (const rule of refsTo(d.name)) {
    for (const [o, k] of [...fieldsOf(state, rule.pattern)]) {
      const v = o[k];
      if (rule.keysTo) { if (v && typeof v === "object" && Object.hasOwn(v, from)) { const e = Object.entries(v).map(([a, b]) => [a === from ? to : a, b] as const); for (const a of Object.keys(v)) delete v[a]; for (const [a, b] of e) v[a] = b; } }
      else if (Array.isArray(v)) o[k] = v.map((x) => (x === from ? to : x));
      else if (v === from) o[k] = to;
    }
  }
  if (d.name === "actors") for (const e of state.game.exited_game) if (e.id === from) e.id = to;
}

/**
 * Domains with when: "change": an entry whose `from` field changed (or went blank) this turn gets a new id, and every reference follows.
 * An id that cannot be made (a hash of an empty name) stays.
 */
export function reidentify(state: GameState, before: GameState): void {
  for (const d of Object.values(ID_DOMAINS)) {
    if (d.when !== "change" || !d.mint) continue;
    for (const id of idsOf(state, d)) {
      const now = entryOf(state, d, id), was = entryOf(before, d, id);
      if (!now || !was || JSON.stringify(now[d.from]) === JSON.stringify(was[d.from])) continue;
      try {
        const rest = idsOf(state, d).filter((x) => x !== id);
        const fresh = mintId(d.mint, { fields: now, from: d.from, ids: rest });
        if (validId(fresh)) renameId(state, d, id, fresh);
      } catch (e) { console.warn(`id of ${d.name} ${id} not changed: ${(e as Error).message}`); }
    }
  }
}

// ---------- paths inside a domain ----------

/**
 * A path that goes through a domain container is checked, and an array entry's id is replaced by its index so the usual walk finds it.
 * Writes (`write`): the entry must exist (a typo would otherwise create a phantom one: use add), must be given a field, and an array
 * entry's id field is never written (it is minted). Reads: an unknown id is left alone.
 */
export function canonPath(state: GameState, path: string, write: boolean): string {
  const parts = path.split(".");
  for (const d of Object.values(ID_DOMAINS)) {
    if (!d.at.every((s, i) => parts[i] === s)) continue;
    const rest = parts.slice(d.at.length);
    if (!rest.length) { if (write && d.name !== "actors") throw new Error(`${path} is a collection: use add and drop`); return path; } // (actors: the usual "bad path")
    const id = rest[0];
    if (!id || UNSAFE.has(id)) return path; // the usual "bad path" follows
    const exists = hasId(state, d, id);
    if (!exists) { if (write) throw new Error(`no such path ${path} (there is no ${d.name} entry "${id}"; use add to create one)`); return path; }
    if (write && rest.length < 2) throw new Error(`${path} must name a field of ${d.name === "actors" ? "an actor" : "an entry"}`);
    if (write && d.key && rest[1] === d.key) throw new Error(`${path} is the id: it is not writable`);
    if (!d.key) return path;
    const idx = (walk(state, d.at) as any[]).findIndex((e) => e?.[d.key!] === id);
    return [...d.at, String(idx), ...rest.slice(1)].join(".");
  }
  return path;
}

/** What the model wrote for a reference field, made into ids. Throws when it is not one. */
export function refValue(state: GameState, op: string, path: string, m: { rule: RefRule; rest: string[] }, value: unknown): unknown {
  const { rule, rest } = m;
  const d = ID_DOMAINS[(rule.to ?? rule.keysTo)!];
  const one = (v: unknown): string => {
    const id = idFrom(state, d, v);
    if (id === null) throw new Error(`${path} must be null or an existing ${d.name} id`);
    return id;
  };
  if (rule.keysTo) {
    if (rest.length === 1) { if (!hasId(state, d, rest[0])) throw new Error(`${path}: "${rest[0]}" is not a ${d.name} id`); return value; }
    if (rest.length === 0 && op === "set" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const k of Object.keys(value)) if (!hasId(state, d, k)) throw new Error(`${path}: "${k}" is not a ${d.name} id`);
    }
    return value;
  }
  if (rest.length) return value;
  if (op === "inc") return value;
  if (value === null) return null;
  if (op === "remove") return idFrom(state, d, value) ?? value;
  if (op === "set" && Array.isArray(value)) {
    const ids = value.map(one);
    return rule.repeat ? ids : [...new Set(ids)];
  }
  return one(value);
}

