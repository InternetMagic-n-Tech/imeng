import { runValidator } from "./validator.js";
import { redactPii } from "./pii.js";
import crypto from "node:crypto";
import {
  JUDGE_ACTOR_FIELDS, JUDGE_HISTORY_ITEMS, JUDGE_EVENTS, USER_ID, WRITABLE_FIELDS, MAX_OPS, MAX_VALUE_CHARS,
  ACTOR_TEMPLATE, ACTOR_DEFAULTS_FROM, DERIVE, SESSION_RULES, FIELD_WORDS, ALIAS_FIELDS, LIMITS, EXIT_WHEN, EXIT_GROUP_WHEN, UNIQUE_FIELDS, DECREASE_LOCKS, ALLOWED_VALUES, STICKY_FIELDS, FIELD_EVIDENCE, VALIDATOR, DATING, FIELD_ROLES, ROLE_FIELD, TONE_FIELDS, WRITE_ONCE, ID_DOMAINS, FIELD_ACCESS, PROTECTED_GAME_PATHS, PROTECTED_ACTOR_FIELD_NAMES, EVENTS_LIMIT, HISTORY_LIMIT, GAME_TURN, DICE_POOL, DEFAULT_DICE_POOL, config,
} from "./config.js";
import { evalCondition, activeActors } from "./conditions.js";
import { applyCalc, enforcePhases, enforceWriters, phasePaths } from "./phases.js";
import { GOALS } from "./goals-config.js";
import { clone, norm } from "./text.js";
import { matchRef, refValue, canonPath, domainOf, domainPath, newIdFor, placeEntry, dropEntry, idFrom, clearRefsTo, reidentify, validId } from "./domains.js";
import type { Actor, Effect, GameState, Op } from "./types.js";

// ---------- initial state ----------
export function initialState(): GameState {
  const s = clone(config.initial_state || {}) as Record<string, any>;
  s.game = { turn: 0, current_actor: null, exited_game: [], events: [], ...(s.game || {}) };
  s.game.rules = Object.fromEntries(
    SESSION_RULES.map((r) => [r.id, {
      text: r.text, locked: !!r.locked, lift_hint: r.lift_hint || "",
      active: true, lift_votes: 0,
    }])
  );
  s.actors = s.actors || {};
  if (!s.actors[USER_ID]) s.actors[USER_ID] = { ...clone(ACTOR_TEMPLATE), name: "you" };
  s.actors[USER_ID].controlled_by = "user";
  return s as GameState;
}

// ---------- state ops ----------
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROTECTED = [...PROTECTED_GAME_PATHS, ...DERIVE.map((d) => d.target)]; // server-owned (prefix match)
const PROTECTED_ACTOR_FIELDS = new Set(PROTECTED_ACTOR_FIELD_NAMES);         // who controls an actor is never the model's call

/** A value an op writes must be small, plain JSON: bounded depth and size, no surprises. */
function checkValue(v: unknown): void {
  const depth = (x: unknown, d: number): number =>
    x !== null && typeof x === "object" ? Math.max(d, ...Object.values(x as object).map((y) => depth(y, d + 1))) : d;
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("value is not a finite number");
  if (v === undefined || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error("value is not plain JSON");
  if (depth(v, 0) > 3) throw new Error("value is nested too deeply");
  if (JSON.stringify(v).length > MAX_VALUE_CHARS) throw new Error(`value is longer than ${MAX_VALUE_CHARS} characters`);
}

function resolve(state: GameState, p: unknown, { create = false } = {}): [Record<string, any>, string] {
  const parts = String(p).split(".");
  if (PROTECTED.some((q) => String(p) === q || String(p).startsWith(q + "."))) throw new Error(`${p} is server-owned`);
  if (!["game", "actors"].includes(parts[0]) || parts.some((k) => !k || BAD_KEYS.has(k))) {
    throw new Error(`bad path ${p}`);
  }
  if (parts.length < 2) throw new Error(`bad path ${p}`);
  if (parts[0] === "actors") {
    // Never a whole actor (that would replace everything, including who controls it): a field of one.
    if (parts.length < 3) throw new Error(`${p} must name a field of an actor`);
    if (PROTECTED_ACTOR_FIELDS.has(parts[2])) throw new Error(`${p} is server-owned`);
    if (WRITABLE_FIELDS && !WRITABLE_FIELDS.has(parts[2])) throw new Error(`field ${parts[2]} is not writable`);
  }
  let obj: Record<string, any> = state as unknown as Record<string, any>;
  for (const k of parts.slice(0, -1)) {
    if (obj[k] === undefined && create) obj[k] = {};
    if (obj[k] === null || typeof obj[k] !== "object") throw new Error(`no such path ${p}`);
    obj = obj[k];
  }
  return [obj, parts[parts.length - 1]];
}

/** Two list entries are the same: strings ignoring case and extra spaces, anything else by value. */
const sameEntry = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" ? norm(a) === norm(b) : JSON.stringify(a) === JSON.stringify(b);

const holds = (v: number, c: { gt?: number; gte?: number; lt?: number; lte?: number; eq?: number }): boolean =>
  (c.gt === undefined || v > c.gt) && (c.gte === undefined || v >= c.gte) && (c.lt === undefined || v < c.lt) && (c.lte === undefined || v <= c.lte) && (c.eq === undefined || v === c.eq);

/** The value a field may hold: when the game lists the allowed values, anything else is rejected and a match (any case) is stored as the listed one. */
function allowedValue(path: string, value: unknown): unknown {
  const parts = path.split(".");
  const list = ALLOWED_VALUES[path] ?? (parts[0] === "actors" ? ALLOWED_VALUES[parts[2]] : undefined);
  if (!list) return value;
  const hit = list.find((x) => sameEntry(x, value));
  if (hit === undefined) throw new Error(`${path} must be one of ${list.map((x) => JSON.stringify(x)).join(", ")}`);
  return hit;
}

/**
 * Does this path touch a field with the given access: the field itself, something inside it, or something that contains it?
 * Keys are written like allowed_values: "game.<field>" (any depth), or an actor field's name (matched against what follows actors.<id>.).
 */
function touches(path: string, want: "read-only" | "write-only"): boolean {
  const parts = path.split(".");
  const forms = parts[0] === "actors" && parts.length >= 3 ? [path, parts.slice(2).join(".")] : [path];
  return Object.entries(FIELD_ACCESS).some(([key, access]) => access === want
    && forms.some((f) => f === key || f.startsWith(key + ".") || key.startsWith(f + ".")));
}

function checkWritable(path: unknown): void {
  if (touches(String(path), "read-only")) throw new Error(`${path} is read-only`);
}

const ADDRESS = /^(game|actors)(\.[^.\s]+)+$/;
const squash = (t: string): string => t.toLowerCase().replace(/\s+/g, "");

/**
 * A string that is exactly the address of a field ("actors.npc_0.score", "game.phase") stands for that field's live value, taken from the
 * state as it is right now (earlier ops of the same answer count). Limits:
 * - Never a server-owned field (game.pending, game.rules, controlled_by...), and never a write-only field (or one that contains it):
 *   that would let a model carry a value somewhere it should not go.
 * - Never an address that appears in the untrusted text this answer was written from (the player's message, the narration): whoever
 *   typed it must not be able to make the engine copy a field, so it stays plain text.
 * - A whole actor ("actors.user") is not a value to copy (actor reference fields still take it as an id).
 * Anything that is not an address is left as it is.
 */
function readAddress(state: GameState, value: unknown, untrusted: string): unknown {
  if (typeof value !== "string") return value;
  const addr = value.trim();
  if (!ADDRESS.test(addr)) return value;
  const parts = addr.split(".");
  if (parts.some((k) => BAD_KEYS.has(k)) || (parts[0] === "actors" && parts.length < 3)) return value;
  // a whole entry ("game.items.sword") is an id, not a value to copy
  if (Object.values(ID_DOMAINS).some((d) => parts.length === d.at.length + 1 && d.at.every((x, i) => parts[i] === x))) return value;
  if (untrusted && untrusted.includes(squash(addr))) return value;
  if (PROTECTED.some((q) => addr === q || addr.startsWith(q + ".")) || (parts[0] === "actors" && PROTECTED_ACTOR_FIELDS.has(parts[2]))) throw new Error(`${addr} is server-owned: it cannot be used as a value`);
  if (touches(addr, "write-only")) throw new Error(`${addr} is write-only: it cannot be used as a value`);
  let cur: unknown = state;
  for (const k of canonPath(state, addr, false).split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, k)) {
      if (parts[0] === "actors" && Object.hasOwn(state.actors, parts[1])) throw new Error(`${addr} does not exist`); // a slip inside a real actor, not text
      return value;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return clone(cur);
}

/** The op with every address in its value replaced by the live value. */
function resolveValues(state: GameState, op: Op, untrusted: string): Op {
  if (!op || typeof op !== "object") return op;
  if (op.op === "set" || op.op === "push" || op.op === "remove" || op.op === "inc") return { ...op, value: readAddress(state, op.value, untrusted) };
  if (op.op === "add_actor" && op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
    return { ...op, value: Object.fromEntries(Object.entries(op.value).map(([k, v]) => [k, readAddress(state, v, untrusted)])) as Actor };
  }
  return op;
}

/** The new entry's fields as an object, checked as plain JSON. */
function entryFields(raw: unknown): Record<string, any> {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("value must be an object");
  const value = { ...((raw as Record<string, any>) || {}) };
  checkValue(value);
  return value;
}

/** Actor fields whose starting value follows a game field (config.json actor_defaults_from). */
export function gameDefaults(state: GameState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [f, p] of Object.entries(ACTOR_DEFAULTS_FROM)) { const v = Number((state.game as Record<string, unknown>)[p.slice(5)]); if (Number.isFinite(v) && v > 0) out[f] = v; }
  return out;
}

function addActor(state: GameState, hint: unknown, raw: unknown): void {
  const value = entryFields(raw) as Actor;
  const id = newIdFor(state, ID_DOMAINS.actors, value, hint);
  for (const field of Object.keys(value)) checkWritable(`actors.${id}.${field}`);
  for (const field of Object.keys(value)) value[field] = allowedValue(`actors.${id}.${field}`, value[field]);
  for (const field of Object.keys(value)) {
    if (WRITABLE_FIELDS && !WRITABLE_FIELDS.has(field) && !PROTECTED_ACTOR_FIELDS.has(field)) throw new Error(`field ${field} is not writable`);
  }
  // controlled_by comes last so a model can't create an actor that claims to be a real player
  state.actors[id] = { ...clone(ACTOR_TEMPLATE), ...gameDefaults(state), ...value, controlled_by: "npc" };
}

function applyOp(state: GameState, op: Op): void {
  const path = String(op.path);
  switch (op.op) {
    case "set": {
      checkWritable(path);
      checkValue(op.value);
      const ref = matchRef(path);
      const value = ref ? refValue(state, "set", path, ref, op.value) : op.value;
      const [o, k] = resolve(state, canonPath(state, path, true), { create: true });
      o[k] = allowedValue(path, value);
      break;
    }
    case "inc": {
      checkWritable(path);
      const ref = matchRef(path);
      if (ref) refValue(state, "inc", path, ref, op.value);
      const [o, k] = resolve(state, canonPath(state, path, true));
      if (typeof o[k] !== "number" || typeof op.value !== "number" || !Number.isFinite(op.value)) throw new Error("inc needs numbers");
      o[k] += op.value;
      break;
    }
    case "push": {
      checkWritable(path);
      checkValue(op.value);
      const ref = matchRef(path);
      const value = ref ? refValue(state, "push", path, ref, op.value) : op.value;
      const [o, k] = resolve(state, canonPath(state, path, true));
      if (!Array.isArray(o[k])) throw new Error("push needs an array");
      const val = allowedValue(path, value);
      if (ref?.rule.to && !ref.rule.repeat && !ref.rest.length && o[k].some((v: unknown) => v === val)) break; // an id list without repeats
      if (UNIQUE_FIELDS.has(String(k)) && o[k].some((v: unknown) => sameEntry(v, val))) break; // already there: the first entry stays
      o[k].push(val);
      break;
    }
    case "remove": { // remove a value from an array
      checkWritable(path);
      const ref = matchRef(path);
      const value = ref ? refValue(state, "remove", path, ref, op.value) : op.value;
      const [o, k] = resolve(state, canonPath(state, path, true));
      if (!Array.isArray(o[k])) throw new Error("remove needs an array");
      o[k] = o[k].filter((v: unknown) => !(UNIQUE_FIELDS.has(String(k)) ? sameEntry(v, value) : JSON.stringify(v) === JSON.stringify(value)));
      break;
    }
    case "add_actor": addActor(state, op.id, op.value); break;
    case "add": { // a new entry in an id domain: the server makes its id
      const d = domainOf(String(op.domain ?? ""));
      if (!d) throw new Error(`unknown domain ${op.domain}`);
      if (d.name === "actors") { addActor(state, op.id, op.value); break; }
      const value = entryFields(op.value);
      if (d.key) delete value[d.key];
      const id = newIdFor(state, d, value, op.id);
      for (const field of Object.keys(value)) checkWritable(`${domainPath(d)}.${id}.${field}`);
      placeEntry(state, d, id, value);
      break;
    }
    case "drop": { // an entry leaves its domain; everything that pointed at it is cleared
      const d = domainOf(String(op.domain ?? ""));
      if (!d || d.name === "actors") throw new Error(d ? "actors leave with exit_actor" : `unknown domain ${op.domain}`);
      const id = idFrom(state, d, op.id);
      if (id === null) throw new Error(`no such ${d.name} entry ${op.id}`);
      dropEntry(state, d, id);
      break;
    }
    case "exit_actor": { // died, eliminated, left the show...
      if (!op.id || !state.actors[op.id]) throw new Error("unknown actor");
      if (state.game.exited_game.some((e) => e.id === op.id)) break; // already out (e.g. by exit_when): nothing to do
      state.game.exited_game.push({ id: op.id, reason: String(op.reason || "").slice(0, 200) });
      clearRefsTo(state, "actors", op.id);
      break;
    }
    case "effect": { // a timed effect on someone: code expires it after `turns` game turns
      if (!GAME_TURN) throw new Error("game turns are off");
      const who = String(op.who ?? "").replace(/^actors\./, "");
      const text = String(op.text ?? "").trim().slice(0, 200), turns = Math.floor(Number(op.turns));
      if (!state.actors[who]) throw new Error("unknown actor");
      if (!text || !(turns >= 1 && turns <= 50)) throw new Error("an effect needs text and turns from 1 to 50");
      const list = (state.game.effects ??= []) as Effect[];
      if (list.length >= 30) throw new Error("too many effects");
      const n = (Number(state.game.effect_seq) || 0) + 1;
      state.game.effect_seq = n;
      list.push({ id: `e${n}`, who, text, until: (Number(state.game.game_turn) || 0) + turns });
      break;
    }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

// Enforce rules in code instead of trusting the model.
function normalize(state: GameState, before: GameState): void {
  reidentify(state, before); // ids that follow a changed field (id_domains: when "change")
  // An actor added this turn whose name is just another actor's alias ("Dr. Okafor" for Marta) is a duplicate: drop it.
  if (ALIAS_FIELDS.length) {
    const aliases = new Set<string>();
    for (const a of Object.values(state.actors)) for (const f of ALIAS_FIELDS) if (typeof a?.[f] === "string" && a[f].trim()) aliases.add(a[f].trim().toLowerCase());
    for (const [id, a] of Object.entries(state.actors)) {
      if (!before.actors[id] && typeof a?.name === "string" && aliases.has(a.name.trim().toLowerCase())) delete state.actors[id];
    }
  }
  for (const d of DERIVE) { const v = (state.game as Record<string, unknown>)[d.from.slice(5)]; (state.game as Record<string, unknown>)[d.target.slice(5)] = Object.prototype.hasOwnProperty.call(d.map, String(v)) ? d.map[String(v)] : d.def; } // game fields that follow another
  const out = new Set(state.game.exited_game.map((e) => e.id));
  const blocked: string[] = []; // changes the server refused this turn, told to the narrator next turn
  for (const [path, { min, max, max_step }] of Object.entries(LIMITS)) { // a limit named `game.<field>` bounds a number of the game's own branch the same way
    const m = /^game\.([\w-]+)$/.exec(path);
    if (!m) continue;
    const g = state.game as Record<string, unknown>, v = g[m[1]!], prev = (before.game as Record<string, unknown>)[m[1]!];
    if (typeof v !== "number") continue;
    let n: number = v;
    if (max_step !== undefined && typeof prev === "number") n = Math.min(prev + max_step, Math.max(prev - max_step, n));
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (n !== v) { g[m[1]!] = n; blocked.push(`${path} was kept within its limits: ${n}.`); }
  }
  for (const [id, a] of Object.entries(state.actors)) {
    if (!a || typeof a !== "object") continue;
    // Ordering rules are judged on the turn's starting record, so two steps in one reply can't skip the order.
    for (const lock of DECREASE_LOCKS) {
      const b = before.actors[id];
      const cond = lock.while ? b?.[lock.while.field] : undefined, was = b?.[lock.field], now = a[lock.field];
      if (typeof was !== "number" || typeof now !== "number" || now >= was) continue;
      if (lock.while && (typeof cond !== "number" || !holds(cond, lock.while))) continue; // no `while`: the field never goes down
      a[lock.field] = was;
      blocked.push(`${nameOf(id, a)}'s ${lock.field} could not go down${lock.reason ? ` (${lock.reason})` : ""}: it stays at ${was}.`);
      console.warn(`${lock.field} of ${id} cannot go down${lock.while ? ` while ${lock.while.field} is ${cond}` : ""}${lock.reason ? ` (${lock.reason})` : ""}: kept at ${was}`);
    }
    for (const f of UNIQUE_FIELDS) { // old saves or a model that bypassed push: keep the first of any repeats
      if (!Array.isArray(a[f])) continue;
      const kept: unknown[] = [];
      for (const v of a[f]) if (!kept.some((k) => sameEntry(k, v))) kept.push(v);
      a[f] = kept;
    }
    for (const [field, { min, max, max_step }] of Object.entries(LIMITS)) {
      const v = a[field];
      if (typeof v !== "number") continue;
      let n: number = v;
      const prev = before.actors[id]?.[field];
      // however many ops it took, one turn can only move a field so far
      if (max_step !== undefined && typeof prev === "number") n = Math.min(prev + max_step, Math.max(prev - max_step, n));
      if (min !== undefined) n = Math.max(min, n);
      if (max !== undefined) n = Math.min(max, n);
      a[field] = n;
    }
  }
  // exits last, on the clamped record; every actor is judged against the same table (aggregates see who was in at the start)
  const snapshot = clone(state);
  for (const [id, a] of Object.entries(state.actors)) {
    if (!a || typeof a !== "object" || out.has(id)) continue; // limits apply to everyone, but nobody leaves twice
    for (const r of EXIT_WHEN) {
      if (evalCondition(r, snapshot, a)) {
        state.game.exited_game.push({ id, reason: r.reason || ("field" in r ? r.field : r.logic) });
        clearRefsTo(state, "actors", id);
        break;
      }
    }
  }
  for (const r of EXIT_GROUP_WHEN) {
    if (!evalCondition(r, state)) continue;
    for (const [id] of activeActors(state)) state.game.exited_game.push({ id, reason: r.reason || ("field" in r ? r.field : r.logic) });
    clearRefsTo(state, "actors", null);
    break;
  }
  applyCalc(state); // server-written values, then the phase gate that may read them
  if (!SERVER_OPS) enforceWriters(state, before, blocked); // the server's own operations are not the narrator's
  enforcePhases(state, before, blocked);
  if (blocked.length) state.game.blocked = blocked; else delete state.game.blocked;
}

export interface ApplyResult {
  state: GameState;
  applied: number;
  skipped: string[];
  /** The same refusals with the op itself, for the repair judge. */
  rejected?: { op: unknown; error: string }[];
  /** Changes dropped because the narration does not contain the phrase field_evidence asks for (not an error). */
  guarded?: string[];
}

/** Apply a list of ops to a copy of the state. Never mutates the input; bad ops are skipped. */
/**
 * A sticky field changes only when the same new value is set on N turns in a row. The first sightings are kept as
 * `game.pending` (server-owned); a turn that does not repeat the proposal drops it. All the usual checks still run first.
 */
function stickySet(state: GameState, op: Op, touched: Set<string>): void {
  const path = String(op.path);
  const probe = clone(state);
  applyOp(probe, op); // throws on anything invalid (protected path, bad value, not allowed...)
  const [po, pk] = resolve(probe, canonPath(probe, path, true)), val = po[pk];
  let cur: unknown;
  try { const [o, k] = resolve(state, canonPath(state, path, true)); cur = o[k]; } catch { cur = undefined; }
  const pending = (state.game.pending ??= {}) as Record<string, { value: unknown; count: number }>;
  if (sameEntry(cur, val)) { delete pending[path]; return; }
  if (cur === undefined || cur === null || cur === "") { applyOp(state, { ...op, value: val }); delete pending[path]; return; } // nothing there yet: the first value sticks at once
  const seen = pending[path];
  const count = seen && sameEntry(seen.value, val) ? seen.count + 1 : 1;
  if (count >= STICKY_FIELDS[path]) { applyOp(state, { ...op, value: val }); delete pending[path]; return; }
  pending[path] = { value: val, count };
  touched.add(path);
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** field_evidence: does the narrator's own text support a change to `field` of `actorId`? True when the field has no rule. */
export function evidenceFor(state: GameState, actorId: string, field: string, narration: string): boolean {
  const tpl = FIELD_EVIDENCE[field];
  if (!tpl) return true;
  const a = state.actors[actorId];
  const names = [a?.name, a?.address_as, actorId].filter((x): x is string => typeof x === "string" && x.length > 0).map(escapeRe);
  try { return new RegExp(tpl.replace(/\{name\}/g, `(?:${names.join("|")})`), "i").test(narration); } catch { return false; }
}

let SERVER_OPS = false; // true while applyServerOps runs (synchronous)
export function applyOps(state: GameState, ops: unknown, opts: { untrusted?: string; narration?: string } = {}): ApplyResult {
  if (!Array.isArray(ops)) throw new Error("ops is not an array");
  const list = (ops as Op[]).map((o) => (o && typeof o === "object" && typeof o.path === "string" && /^(game\.)?imeng\./.test(o.path) ? { ...o, path: "game." + o.path.replace(/^(game\.)?imeng\./, "") } : o)); // the branch may be named either way (a model also writes game.imeng.<field>)
  const next = clone(state);
  let applied = 0;
  const skipped: string[] = [], guarded: string[] = [], rejected: { op: unknown; error: string }[] = [];
  if (list.length > MAX_OPS) skipped.push(`${list.length - MAX_OPS} op(s) beyond the limit of ${MAX_OPS} per answer`);
  const touched = new Set<string>();
  const untrusted = squash(opts.untrusted || ""); // text the answer was written from: an address typed there is never followed
  const gate = phasePaths(state); // a phase that lists actions only lets their paths change (and game.phase)
  for (const op of list.slice(0, MAX_OPS)) {
    try {
      const target = /^actors\.([^.]+)\.(\w+)$/.exec(String((op as Op)?.path ?? ""));
      if (target && FIELD_EVIDENCE[target[2]] && !evidenceFor(next, target[1], target[2], opts.narration ?? "")) { guarded.push(`${JSON.stringify(op)}: the narration does not say it`); continue; }
      if (gate && typeof (op as Op)?.path === "string" && (op as Op).path !== "game.phase" && !gate.some((g) => g.test(String((op as Op).path)))) { guarded.push(`${JSON.stringify(op)}: not something this phase allows`); continue; }
      const rg = /^actors\.([^.]+)\.([\w-]+)$/.exec(String((op as Op)?.path ?? ""));
      if (rg && FIELD_ROLES[rg[2]!]) { // some fields may only change on actors with the right role (the Host is never gak'd)
        const role = next.actors[rg[1]!]?.[ROLE_FIELD];
        if (typeof role === "string" && role && !FIELD_ROLES[rg[2]!]!.includes(role)) { guarded.push(`${JSON.stringify(op)}: ${rg[2]} cannot change for role ${role}`); continue; }
      }
      if (rg && WRITE_ONCE.includes(rg[2]!)) { // a write-once field: the first op that sets it locks it
        const locked = (next.game.locked && typeof next.game.locked === "object" ? next.game.locked : {}) as Record<string, true>;
        if (locked[`${rg[1]}.${rg[2]}`]) { guarded.push(`${JSON.stringify(op)}: ${rg[2]} cannot change once set`); continue; }
        next.game.locked = { ...locked, [`${rg[1]}.${rg[2]}`]: true };
      }
      const o = resolveValues(next, op, untrusted); // addresses in the value become live values before anything else looks at it
      const bad = VALIDATOR ? runValidator(VALIDATOR, o, next) : null; // the imeng's own rules, before the engine's
      if (bad) throw new Error(bad);
      if (!SERVER_OPS && o?.op === "set" && STICKY_FIELDS[String(o.path)] !== undefined) stickySet(next, o, touched); else applyOp(next, o); // the server's own writes (a hazard moving everyone to the shelter) are not proposals to confirm
      applied++;
    } catch (e) { skipped.push(`${JSON.stringify(op)}: ${(e as Error).message}`); rejected.push({ op, error: (e as Error).message }); }
  }
  const pend = next.game.pending as Record<string, unknown> | undefined; // a proposal not repeated this turn is dropped
  if (pend) { for (const k of Object.keys(pend)) if (!touched.has(k)) delete pend[k]; if (!Object.keys(pend).length) delete next.game.pending; }
  if (next.game.events.length > EVENTS_LIMIT) next.game.events = next.game.events.slice(-EVENTS_LIMIT);
  normalize(next, state);
  for (const a of Object.values(next.actors)) {
    if (Array.isArray(a?.history) && a.history.length > HISTORY_LIMIT) {
      a.history = a.history.slice(-HISTORY_LIMIT);
    }
  }
  return { state: next, applied, skipped, ...(rejected.length ? { rejected } : {}), ...(guarded.length ? { guarded } : {}) };
}

// ---------- trimmed view for the judge models ----------
export interface JudgeView {
  actors: Record<string, Record<string, unknown>>;
  recent_events?: string[];
}

/**
 * Just the story-relevant part of the state: who is in play (no stats or gear), their recent
 * history, the recent plot events and who has left. Keeps the small judge models focused.
 */
export function judgeView(state: GameState): JudgeView {
  const out = new Set(state.game.exited_game.map((e) => e.id));
  const actors: JudgeView["actors"] = {};
  for (const [id, a] of Object.entries(state.actors)) {
    if (!a || typeof a !== "object") continue;
    const v: Record<string, unknown> = {};
    for (const f of JUDGE_ACTOR_FIELDS) {
      const val = a[f];
      if (val === undefined || val === null || val === "" || (Array.isArray(val) && !val.length)) continue;
      v[f] = Array.isArray(val) && f === "history" ? val.slice(-JUDGE_HISTORY_ITEMS) : val;
    }
    if (out.has(id)) v.left_game = state.game.exited_game.find((e) => e.id === id)?.reason || true;
    actors[id] = v;
  }
  const view: JudgeView = { actors };
  if (state.game.events?.length) view.recent_events = state.game.events.slice(-JUDGE_EVENTS);
  return view;
}

// ---------- prompt blocks ----------
/** The tone fields of every actor in play, in plain words, so the narrator keeps each character's voice (empty when the game has no tone_fields). */
export function toneBlock(state: GameState): string {
  if (!TONE_FIELDS.length) return "";
  const gone = new Set((state.game.exited_game || []).map((e) => e.id));
  const lines = Object.entries(state.actors).filter(([id, a]) => !gone.has(id) && a && typeof a === "object").flatMap(([id, a]) => {
    const bits = TONE_FIELDS.map((f) => [f, a[f]] as const).filter(([, v]) => typeof v === "string" && v.trim()).map(([f, v]) => `${f}: ${String(v).replace(/\s+/g, " ").trim().slice(0, 160)}`);
    return bits.length ? [`- ${String(a.name || id)}${typeof a[ROLE_FIELD] === "string" && a[ROLE_FIELD] ? ` (${a[ROLE_FIELD]})` : ""}: ${bits.join("; ")}`] : [];
  });
  return lines.length ? `\n\n## CHARACTER VOICE (written by the server)\nNames and personal details are masked, but these cues are real. Keep each character's manner, look and way of speaking true to them.\n${lines.join("\n")}` : "";
}

/** What the narrator reads: the `game` branch is shown as `imeng`. */
function renameBranch(shown: Record<string, unknown>): Record<string, unknown> {
  const { game, ...rest } = shown as { game?: unknown } & Record<string, unknown>;
  return { imeng: game, ...rest };
}

export function stateBlock(state: GameState): string {
  const ageField = DATING?.ageField;
  const groups = ageField ? Object.fromEntries(Object.entries(state.actors).map(([id, a]) => { const v = (a ?? {})[ageField]; return [id, typeof v === "number" ? (v >= 18 ? "adult" : "minor") : "unknown"]; })) : null;
  state = redactPii(state); // config.json pii: personal fields never reach the model
  if (groups) { state = { ...state, actors: Object.fromEntries(Object.entries(state.actors).map(([id, a]) => { const { [ageField!]: _age, ...rest } = (a ?? {}) as Record<string, unknown>; return [id, { ...rest, age_group: groups[id] }]; })) } as GameState; } // the real age is for code only: the narrator hears adult or minor
  const { rules, pending, attraction, ...game } = state.game; // the narrator never sees pending changes or anyone's feelings
  const shown = GOALS?.host === "blind"
    ? { ...state, game, actors: Object.fromEntries(Object.entries(state.actors).map(([id, a]) => { const { goals_set, goals_done, ...rest } = (a ?? {}) as Record<string, unknown>; return [id, rest]; })) }
    : { ...state, game };
  const active = Object.entries(rules).filter(([, r]) => r.active);
  const fresh = Object.entries(rules).filter(([, r]) => !r.active && !r.announced);
  let out = `\n\n## CURRENT GAME STATE (authoritative, maintained by the server)\n\`\`\`json\n${JSON.stringify(renameBranch(shown), null, 2)}\n\`\`\`\nNever contradict this state. Actors listed in game.exited_game are out of the game.\nActors with controlled_by "user" or "other_player" are real people: never write their actions, words or thoughts; only narrate how the world responds. Actors with controlled_by "npc" are yours to voice and control.`;
  if (active.length) {
    out += `\n\n## SESSION RULES IN EFFECT (obey these)\n` + active.map(([, r]) => `- ${r.text}`).join("\n");
  }
  if (fresh.length) {
    out += `\n\n## RULES JUST LIFTED (no longer apply; let the story acknowledge the change naturally this turn)\n` +
      fresh.map(([, r]) => `- ${r.text}\n  Why it ended: ${r.lifted_reason}`).join("\n");
  }
  return out;
}

/** Roll `pool` ({"d20": 8, "d6": 4}: die -> how many) with crypto randomness, and describe it for the narrator. */
export function diceBlock(pool: Record<string, number> = DICE_POOL ?? DEFAULT_DICE_POOL): string {
  const rolls: string[] = [];
  for (const [die, count] of Object.entries(pool)) {
    const sides = /^d(\d+)$/i.exec(die)?.[1];
    if (!sides || Number(sides) < 2 || !Number.isInteger(count) || count < 1) continue;
    const values = Array.from({ length: Math.min(count, 100) }, () => crypto.randomInt(1, Number(sides) + 1));
    rolls.push(`${die.toLowerCase()}: [${values.join(", ")}]`);
  }
  return `\n\n## DICE (rolled by the server for this turn)\nUse these in order, left to right, for every roll this turn, and never invent a roll. Show each roll you use in the narration, like (d20: 14).\n` + rolls.join("\n");
}

// ---------- plain-language notes for the narrator ----------
const SERVER_FIELDS = new Set(["controlled_by", "history"]);
const tidy = (t: unknown, n = 80): string => String(t).replace(/\s+/g, " ").trim().slice(0, n);
const nameOf = (id: string, a?: Actor): string => tidy(a?.name || id, 60) || id;

/** The word a game gives to a numeric value ("cold"), or "" when it defines none. */
export function wordFor(field: string, value: number): string {
  const bands = FIELD_WORDS[field];
  if (!Array.isArray(bands)) return "";
  let word = "";
  for (const [bound, w] of [...bands].sort((x, y) => x[0] - y[0])) if (value >= bound) word = w;
  return word;
}

const describeNumber = (field: string, v: number): string => { const w = wordFor(field, v); return w ? `${v} (${w})` : String(v); };

/** One actor as a short sentence: who controls them and their notable fields, in words where the game gave some. */
function describeActor(id: string, a: Actor, out: Map<string, string>): string {
  const bits: string[] = [];
  for (const [f, v] of Object.entries(a)) {
    if (SERVER_FIELDS.has(f) || f === "name" || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (typeof v === "number") bits.push(`${f} ${describeNumber(f, v)}`);
    else if (typeof v === "string") bits.push(`${f}: ${tidy(v, 120)}`);
    else if (Array.isArray(v)) bits.push(`${f}: ${v.slice(-8).map((x) => tidy(typeof x === "string" ? x : JSON.stringify(x), 40)).join(", ")}`);
  }
  const who = a.controlled_by === "user" || a.controlled_by === "other_player" ? "a real person, never write their words" : "yours to voice";
  const gone = out.get(id);
  return `- ${nameOf(id, a)} (${who})${gone ? ` [OUT OF THE GAME: ${tidy(gone, 60)}]` : ""}${bits.length ? ": " + bits.join("; ") : ""}`;
}

/**
 * Plain-language notes for the narrator, built by the server (no model involved): what the record says changed
 * since the narrator last saw it, plus a full catch-up (everyone, in words) when `catchUp` gives reasons the story
 * and the record may be out of step. The JSON state stays the source of truth; this is how to talk about it.
 */
export function stateNotes(prev: GameState | undefined, cur: GameState, catchUp: string[] = []): string {
  const was = new Set((prev?.game.exited_game ?? []).map((e) => e.id));
  const out = new Map(cur.game.exited_game.map((e) => [e.id, e.reason]));
  const changes: string[] = [];
  for (const [id, a] of Object.entries(cur.actors)) {
    if (!a || typeof a !== "object") continue;
    const before = prev?.actors[id];
    const n = nameOf(id, a);
    if (prev && !before) { changes.push(`${n} joined${a.description ? `: ${tidy(a.description, 120)}` : ""}.`); continue; }
    for (const [f, v] of Object.entries(a)) {
      if (SERVER_FIELDS.has(f)) continue;
      const old = before?.[f];
      if (typeof v === "number" && typeof old === "number" && v !== old) {
        changes.push(`${n}'s ${f} went ${v > old ? "up" : "down"} from ${describeNumber(f, old)} to ${describeNumber(f, v)}.`);
      } else if (Array.isArray(v) && Array.isArray(old)) {
        const added = v.filter((x) => !old.some((y) => JSON.stringify(y) === JSON.stringify(x)));
        if (added.length) changes.push(`${n}'s ${f} gained ${added.slice(0, 5).map((x) => tidy(typeof x === "string" ? x : JSON.stringify(x), 40)).join(", ")}.`);
      }
    }
  }
  for (const b of (Array.isArray(cur.game.blocked) ? cur.game.blocked : []).slice(0, 5)) changes.push(`Your last reply described a change the server did not allow: ${tidy(String(b), 200)} Do not repeat it as if it happened.`);
  for (const [id, reason] of out) if (!was.has(id)) changes.push(`${nameOf(id, cur.actors[id])} is now out of the game: ${tidy(reason, 60)}.`);

  let text = "";
  if (changes.length) text += `\n\n## STATE NOTES (written by the server, in plain words)\nSince your last turn the record shows:\n${changes.map((c) => `- ${c}`).join("\n")}\nThe JSON state is the truth. Describe these changes in your own words and match their intensity (hardly, a lot, completely) without quoting numbers, and let a person who is out of the game stay out.`;
  if (catchUp.length) {
    const who = Object.entries(cur.actors).filter(([, a]) => a && typeof a === "object").map(([id, a]) => describeActor(id, a, out));
    const events = (cur.game.events ?? []).slice(-5).map((e) => `- ${tidy(e, 160)}`);
    text += `\n\n## CATCH-UP (written by the server)\n${catchUp.map((c) => `- ${c}`).join("\n")}\nWhere the record says things stand:\n${who.join("\n")}${events.length ? `\nRecent events:\n${events.join("\n")}` : ""}\nTrust this over any conflicting detail you half-remember, and carry on without mentioning the catch-up.`;
  }
  return text;
}

/** Operations written by the server's own code (a hazard, a phase hook): `set` on a server-owned game path is allowed here (the narrator's path stays gated). Others go through applyOps. */
export function applyServerOps(state: GameState, ops: unknown[]): { state: GameState; skipped: string[] } {
  const own: { path: string; value: unknown }[] = [], rest: unknown[] = [];
  for (const o of ops as any[]) {
    const p = o && typeof o.path === "string" ? (o.path.startsWith("imeng.") ? "game." + o.path.slice(6) : o.path) : "";
    if (o?.op === "set" && /^game\.[A-Za-z0-9_]+$/.test(p) && PROTECTED.some((q) => p === q)) own.push({ path: p, value: o.value }); else rest.push(o);
  }
  SERVER_OPS = true;
  let r: { state: GameState; skipped: string[] };
  try { r = rest.length ? applyOps(state, rest) : { state: structuredClone(state), skipped: [] as string[] }; } finally { SERVER_OPS = false; }
  for (const w of own) (r.state.game as Record<string, unknown>)[w.path.slice(5)] = w.value;
  return { state: r.state, skipped: r.skipped };
}
