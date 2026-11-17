import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RANDOM_EVENTS, HAZARDS, IMENG_PATH } from "./config.js";
import { evalCondition, type Condition } from "./conditions.js";
import { applyOps, applyServerOps } from "./state.js";
import type { GameState, Session } from "./types.js";

/**
 * Events the server rolls (config.json `random_events`): after each round, every event whose condition holds has `chance` (0 to 1) of happening, decided by code, never by
 * the narrator. An event sets state (`set`) and gives the narrator a line to dramatise next round. `once` events (the default) can happen one time per game.
 */
export interface RolledEvent { id: string; text: string }

export function rollEvents(session: Session, state: GameState, round: number, rng: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000): { state: GameState; fired: RolledEvent[] } {
  let cur = state;
  const fired: RolledEvent[] = [];
  const done = new Set<string>(Array.isArray(cur.game.events_rolled) ? (cur.game.events_rolled as string[]) : []);
  for (const e of RANDOM_EVENTS) {
    if (e.once && done.has(e.id)) continue;
    if (e.if !== undefined && !evalCondition(e.if as Condition, cur)) continue;
    if (rng() >= e.chance) continue;
    const ops = Object.entries(e.set).map(([path, value]) => ({ op: "set", path, value }));
    if (ops.length) { const r = applyOps(cur, ops); cur = r.state; for (const s of r.skipped) console.warn(`random event ${e.id}: ${s}`); }
    done.add(e.id);
    fired.push({ id: e.id, text: e.text });
    (session.pendingEvents ??= []).push({ round, text: e.text });
    console.log(`random event: ${e.id} happened after round ${round}`);
  }
  if (fired.length) cur.game.events_rolled = [...done].slice(-100);
  return { state: cur, fired };
}

/** What the narrator is told on the round after an event happened. */
export function eventsBlock(session: Session, round: number): string {
  if (!RANDOM_EVENTS.length && !HAZARDS) return "";
  const now = (session.pendingEvents ?? []).filter((e) => e.round === round - 1);
  session.pendingEvents = (session.pendingEvents ?? []).filter((e) => e.round >= round - 1);
  return now.length ? `\n\n## SOMETHING JUST HAPPENED (rolled by the server; it is already true, dramatise it)\n${now.map((e) => `- ${e.text}`).join("\n")}` : "";
}

// ---------- hazards ----------
export type HazardChance = (a: { hazard: string; region: string; lat?: number; lon?: number; season: string; base: number; modifier: number; count?: number; state: GameState }) => number | undefined | Promise<number | undefined>;
let chanceFn: HazardChance | null | undefined;
async function loadChance(): Promise<HazardChance | null> {
  if (chanceFn !== undefined) return chanceFn;
  const file = HAZARDS?.file;
  if (!file) return (chanceFn = null);
  const p = path.resolve(IMENG_PATH, file);
  if (!p.startsWith(path.resolve(IMENG_PATH) + path.sep) || !fs.existsSync(p)) { console.warn(`hazards: ${file} not found inside the imeng folder; the table's own chances are used`); return (chanceFn = null); }
  const mod: any = await import(/* @vite-ignore */ p);
  return (chanceFn = typeof (mod.hazardChance ?? mod.default) === "function" ? (mod.hazardChance ?? mod.default) : null);
}
/** For tests: forget the loaded chance function. */
export const _resetHazards = (): void => { chanceFn = undefined; };

const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One roll after a round: at most one hazard happens per game (the move to the shelter is the point). The chance is the table's, times the season's, times the producer's modifier, or whatever the imeng's function says. */
export async function rollHazards(session: Session, state: GameState, round: number, rng: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000): Promise<GameState> {
  if (!HAZARDS || HAZARDS.trigger === "producer") return state;
  const g = state.game as Record<string, unknown>;
  if (HAZARDS.phase && g.phase !== HAZARDS.phase) return state;
  const count = Number(g.hazard_count) || 0, decay = Math.pow(HAZARDS.repeat, count); // a second hazard in a 22 minute show is far less likely, not impossible
  const region = String(g.region ?? "").toLowerCase(), season = String(g.season ?? "").toLowerCase();
  if (!region) return state;
  const modifier = Math.max(0, asNum(g.hazard_mod) ?? 1);
  const fn = await loadChance();
  for (const h of HAZARDS.table.filter((x: { regions: string[]; if?: { field: string; is: string } }) => (x.regions.includes(region) || x.regions.includes("*")) && (!x.if || String(g[x.if.field] ?? "") === x.if.is))) {
    const base = h.chance * (h.seasons[season] ?? 1);
    let chance = base * modifier * decay;
    if (fn) { try { const v = await fn({ hazard: h.id, region, lat: asNum(g.lat), lon: asNum(g.lon), season, base, modifier, state, count }); if (typeof v === "number" && Number.isFinite(v)) chance = v; } catch (e) { console.warn(`hazards: the chance function failed (table chance used): ${(e as Error).message}`); } }
    if (!(rng() < Math.min(1, Math.max(0, chance)))) continue;
    return happen(session, state, round, h.id, h.text, h.set && Object.keys(h.set).length ? h.set : HAZARDS.shelter.set);
  }
  return state;
}

/** The producer calls the shelter (the owner's /shelter): the same move, at once, whatever the dice say. */
export function callShelter(session: Session, state: GameState, round: number): GameState | null {
  if (!HAZARDS || HAZARDS.trigger === "roll") return null;
  return happen(session, state, round, "producer", HAZARDS.shelter.text, HAZARDS.shelter.set);
}

function happen(session: Session, state: GameState, round: number, id: string, text: string, set: Record<string, unknown>): GameState {
  const ops = Object.entries(set).map(([p, value]) => ({ op: "set", path: p, value }));
  let cur = state;
  if (ops.length) { const r = applyServerOps(cur, ops); cur = r.state; for (const s of r.skipped) console.warn(`hazard ${id}: ${s}`); }
  const gg = cur.game as Record<string, unknown>; gg.hazard_done = id; gg.hazard_count = (Number(gg.hazard_count) || 0) + 1;
  (session.pendingEvents ??= []).push({ round, text });
  console.log(`hazard: ${id} after round ${round}`);
  return cur;
}
