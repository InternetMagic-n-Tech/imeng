import { CALCULATED, PHASES, PHASE_START, PHASE_TEXTS } from "./config.js";
import { dbg } from "./debug.js";
const log = dbg("phases");
import { activeActors, evalCondition, isLogic, valueMeets } from "./conditions.js";
import type { Condition, Leaf } from "./conditions.js";
import type { GameState } from "./types.js";

/**
 * Calculated fields and phases (see docs/IMENG-MAKING.md). Both are the server's: `game.calc` is written only here (it is a protected path, so no op
 * can touch it), and `game.phase` can only move along the game's own steps when their conditions hold. The model proposes, this code decides.
 */

const fill = (t: string, vars: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
const fieldOf = (of: string): string | null => /^actors\.\*\.([\w-]+)$/.exec(of)?.[1] ?? null;
const isMap = (v: unknown): v is Record<string, number> => !!v && typeof v === "object" && !Array.isArray(v);

const matches = (item: unknown, where: Record<string, unknown> | undefined): boolean =>
  !where || (!!item && typeof item === "object" && Object.entries(where).every(([k, v]) => (item as Record<string, unknown>)[k] === v));

/** One value per actor still in the game, or one number, from what the earlier calculated values and the actors' fields say. */
function source(state: GameState, of: string, done: Record<string, unknown>): Record<string, number> | null {
  if (isMap(done[of])) return done[of] as Record<string, number>;
  const f = fieldOf(of);
  if (!f) return null;
  const out: Record<string, number> = {};
  for (const [id, a] of activeActors(state)) if (typeof a?.[f] === "number" && Number.isFinite(a[f])) out[id] = a[f] as number;
  return out;
}

/** Work out every calculated value, in the order they are declared (a later one may use an earlier one). */
export function computeCalc(state: GameState): Record<string, unknown> {
  const done: Record<string, unknown> = {};
  for (const [name, d] of Object.entries(CALCULATED)) {
    if (d.kind === "count") {
      const f = fieldOf(d.of), out: Record<string, number> = {};
      for (const [id, a] of activeActors(state)) {
        const v = f ? a?.[f] : undefined;
        out[id] = Array.isArray(v) ? v.filter((x) => matches(x, d.where)).length : 0;
      }
      done[name] = out;
      continue;
    }
    const m = source(state, d.of, done);
    if (!m) { done[name] = d.kind.startsWith("arg") ? null : 0; continue; }
    const vals = Object.values(m);
    if (d.kind === "sum") done[name] = vals.reduce((x, y) => x + y, 0);
    else if (d.kind === "min") done[name] = vals.length ? Math.min(...vals) : 0;
    else if (d.kind === "max") done[name] = vals.length ? Math.max(...vals) : 0;
    else {
      const top = vals.length ? (d.kind === "argmax" ? Math.max(...vals) : Math.min(...vals)) : NaN;
      const ids = Object.entries(m).filter(([, v]) => v === top).map(([id]) => id);
      done[name] = ids.length === 1 && (d.kind === "argmax" ? top >= d.at_least : top <= d.at_least) ? ids[0] : null;
    }
  }
  return done;
}

/** Store the calculated values in the state (nothing when the game has none). */
export function applyCalc(state: GameState): void {
  if (!Object.keys(CALCULATED).length) return;
  state.game.calc = computeCalc(state);
}

/** The gated phase the game is in (it moves only along its `next` routes), or null. Players cannot skip it (/idle, producer moves). */
export const gatedPhase = (state: GameState, what = "idle"): string | null => { const p = phaseOf(state); return gateHolds(state, p, what) ? p : null; };
/** What a player is told when a gated phase refuses them. */
export const gateText = (phase: string): string => PHASE_TEXTS.gated.replace("{phase}", phase).replace("{next}", PHASES?.[phase]?.next.join(" / ") || "the next step");

/** Does phase `p` hold back `what` right now (it is gated for that, and its `when` condition, if any, is true)? */
function gateHolds(state: GameState, p: string, what: string): boolean {
  const g = PHASES?.[p]?.gated;
  return !!g && g.blocks.includes(what) && (g.when === undefined || holds(g.when, state));
}

export const phaseOf = (state: GameState): string => (typeof state.game.phase === "string" && PHASES?.[state.game.phase] ? state.game.phase : PHASE_START);

const holds = (c: unknown, state: GameState): boolean => evalCondition(c as Condition, state);

/** The phase "@return" goes back to: the one an interrupt phase interrupted. */
const resumeOf = (state: GameState): string | null => (typeof state.game.resume === "string" && PHASES?.[state.game.resume] ? state.game.resume : null);

/** May the game go from one phase to another right now? An interrupt phase can be entered from anywhere; "@return" goes back to the interrupted phase. */
export function allowed(state: GameState, from: string, to: string): boolean {
  const a = PHASES?.[from], b = PHASES?.[to];
  if (!a || !b || (b.enter_when !== undefined && !holds(b.enter_when, state))) return false;
  if (b.interrupt && !a.interrupt && !gateHolds(state, from, "interrupt")) return true; // a gated phase cannot be interrupted: it goes only along its routes
  return a.next.includes(to) && a.require.every((r) => holds(r, state));
}

const patternOf = (p: string): RegExp => new RegExp("^" + p.split(".").map((k) => (k === "*" ? "[^.]+" : k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.") + "$");

/** The paths a player's words may change in the current phase, or null when the phase does not gate (it lists no actions and no `allow`). */
export function phasePaths(state: GameState): RegExp[] | null {
  if (!PHASES || !PHASE_START) return null;
  const d = PHASES[phaseOf(state)];
  if (!d || (!Object.keys(d.actions).length && !d.allow.length)) return null;
  return [...d.allow, ...Object.values(d.actions).flatMap((a) => a.allow)].map(patternOf);
}

/** The actions of the current phase (name and description), for the off-phase gate. */
export function phaseActions(state: GameState): { name: string; describe: string }[] {
  const d = PHASES?.[phaseOf(state)];
  return d ? Object.entries(d.actions).map(([name, a]) => ({ name, describe: a.describe })) : [];
}

/** Gate game.phase after a turn's changes: a move that is not allowed is undone (and reported); an exit_when that holds moves the game on. */
export function enforcePhases(state: GameState, before: GameState, blocked: string[]): void {
  if (!PHASES || !PHASE_START) return;
  const from = phaseOf(before);
  const asked = state.game.phase;
  if (asked !== undefined && asked !== from && !(typeof asked === "string" && (allowed(state, from, asked) || (PHASES[from].next.includes("@return") && asked === resumeOf(before) && stepTo(state, from) === asked)))) {
    if (typeof asked === "string") blocked.push(`${fill(PHASE_TEXTS.blocked, { to: asked })}.`);
    console.warn(`phase: ${JSON.stringify(asked)} refused, the game stays in ${from}`);
    log("refused %j, staying in %s", asked, from);
    state.game.phase = from;
  } else if (asked === undefined || asked === null) state.game.phase = from;
  let cur = phaseOf(state), def = PHASES[cur];
  if (state.game.phase === from && def.exit_when !== undefined && holds(def.exit_when, state)) {
    const to = stepTo(state, cur);
    if (to) { state.game.phase = to; console.log(`phase: ${cur} -> ${to}`); log("%s -> %s (exit_when)", cur, to); }
  }
  noteInterrupt(state, from);
  const g = PHASES[from];
  const limit = typeof g.maxRounds === "string" ? Math.floor(Number(g.maxRounds.split(".").slice(1).reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), state.game))) || 0 : g.maxRounds;
  if (state.game.phase === from && g.gated && limit > 0) { // a gated phase ends by itself after max_rounds (a number, or a state path the table agreed at registration) of the narrator's turns
    const n = (Number(before.game.phase_rounds) || 0) + 1;
    const to = n >= limit ? stepTo(state, from) : null;
    if (to) { state.game.phase = to; console.log(`phase: ${from} -> ${to} (max_rounds)`); log("%s -> %s (max_rounds)", from, to); noteInterrupt(state, from); }
    else state.game.phase_rounds = n;
  }
  if (state.game.phase !== from) delete state.game.phase_rounds;
  // Silent phases are pass-throughs: the server moves on in the same turn, with no reply of its own.
  for (let hops = 0; hops < 8; hops++) {
    cur = phaseOf(state); def = PHASES[cur];
    if (!def.silent) break;
    const to = stepTo(state, cur);
    if (!to) break;
    state.game.phase = to; console.log(`phase: ${cur} -> ${to} (silent)`); log("%s -> %s (silent)", cur, to);
    noteInterrupt(state, cur);
  }
}

/** Where a phase goes next on its own: the first `next` that is allowed ("@return" is the interrupted phase). */
function stepTo(state: GameState, cur: string): string | null {
  const def = PHASES![cur];
  for (const n of def.next) {
    if (n === "@return") { const r = resumeOf(state); if (r && (PHASES![r].enter_when === undefined || holds(PHASES![r].enter_when, state)) && def.require.every((q) => holds(q, state))) return r; continue; }
    if (allowed(state, cur, n)) return n;
  }
  return null;
}

/** Entering an interrupt phase remembers the phase it came from; leaving one for good forgets it. */
function noteInterrupt(state: GameState, from: string): void {
  const now = phaseOf(state);
  if (now === from) return;
  if (PHASES![now].interrupt && !PHASES![from].interrupt) state.game.resume = from;
  else if (!PHASES![now].interrupt) delete state.game.resume;
}

/** What is not yet true in a requirement, in the game's words (`reason`) or as the field and who still lacks it. */
function missing(c: Condition, state: GameState): string {
  if (evalCondition(c, state)) return "";
  if (c.reason) return c.reason;
  if (isLogic(c)) return c.conditions.map((x) => missing(x, state)).filter(Boolean).join("; ") || c.logic;
  const l = c as Leaf;
  if (l.field.startsWith("game.") || l.aggregate) return l.field;
  const who = activeActors(state).filter(([, a]) => !valueMeets(a?.[l.field], l)).map(([id, a]) => String(a?.name || id));
  return `${l.field}${who.length ? `: ${who.join(", ")}` : ""}`;
}

/** What the narrator is told about the phase on this round. */
export function phaseBlock(state: GameState): string {
  if (!PHASES || !PHASE_START) return "";
  const cur = phaseOf(state), def = PHASES[cur];
  const lines = [fill(PHASE_TEXTS.here, { phase: cur })];
  if (def.note) lines.push(def.note);
  const what = def.require.map((r) => missing(r as Condition, state)).filter(Boolean);
  if (gateHolds(state, cur, "idle") || gateHolds(state, cur, "deal")) lines.push(fill(PHASE_TEXTS.gated, { phase: cur, next: def.next.join(" / ") }));
  if (what.length) lines.push(fill(PHASE_TEXTS.missing, { next: def.next.join(" / "), what: what.join("; ") }));
  return `\n\n## GAME PHASE (written by the server)\n${lines.join("\n")}`;
}

/** Put back what this phase does not let the narrator change (phases.<name>.writers), and say so. Called after the turn's operations. */
export function enforceWriters(state: GameState, before: GameState, blocked: string[]): void {
  if (!PHASES || !PHASE_START) return;
  const w = PHASES[phaseOf(before)]?.writers;
  if (!w || !Object.keys(w).length) return;
  for (const [key, who] of Object.entries(w)) {
    if (key.startsWith("game.")) {
      const f = key.slice(5);
      if (who.includes("narrator") || JSON.stringify((state.game as any)[f]) === JSON.stringify((before.game as any)[f])) continue;
      if ((before.game as any)[f] === undefined) delete (state.game as any)[f]; else (state.game as any)[f] = (before.game as any)[f];
      blocked.push(`${key} cannot be changed by the narrator in this phase.`);
      continue;
    }
    for (const [id, a] of Object.entries(state.actors)) {
      const b = before.actors[id];
      if (!a || !b || JSON.stringify(a[key]) === JSON.stringify(b[key]) || who.includes(String((b as any).controlled_by))) continue;
      if (b[key] === undefined) delete a[key]; else a[key] = b[key];
      blocked.push(`${String(a.name || id)}'s ${key} cannot be changed in this phase (only ${who.join(" or ")} may).`);
    }
  }
}
