import fs from "node:fs";
import path from "node:path";
import { PHASES, PHASE_HOOK, IMENG_PATH, DEAL, BETTING, BLINDS, PAY } from "./config.js";
import { releaseEscrow } from "./pay.js";
import { startHand, playNpcs } from "./poker-bet.js";
import { dealOps } from "./poker-deal-turn.js";
import { applyServerOps } from "./state.js";
import { recordDeal } from "./audit.js";
import { logHand } from "./hand-log.js";
import type { GameState, Session } from "./types.js";

/**
 * Phase changes driven by code (config.json `phases.hook`: a .mjs in the imeng folder). It exports `next({from, to, state, event})` and returns `{ops, phase?}`:
 * `ops` are change operations (the same set/push/add_actor the narrator uses, never a replacement state) applied as the game enters `to`; `phase` (optional) sends it on to another phase
 * at once (for example a producer's /end). `event` is why: "state" (the narrator or a rule moved it), "hazard", or a producer command ("move", "end"). Never throws: a bad hook leaves the state as it was.
 */
export type PhaseHook = (a: { from: string; to: string; state: GameState; event: string; args?: Record<string, unknown> }) => { ops?: unknown[]; phase?: string } | void | Promise<{ ops?: unknown[]; phase?: string } | void>;
const ROUTED = !!PHASES && Object.values(PHASES).some((p) => Object.keys(p.routes).length > 0);
let fn: PhaseHook | null | undefined;
async function load(): Promise<PhaseHook | null> {
  if (fn !== undefined) return fn;
  if (!PHASE_HOOK) return (fn = null);
  const p = path.resolve(IMENG_PATH, PHASE_HOOK);
  if (!p.startsWith(path.resolve(IMENG_PATH) + path.sep) || !fs.existsSync(p)) { console.warn(`phases.hook: ${PHASE_HOOK} not found inside the imeng folder`); return (fn = null); }
  const mod: any = await import(/* @vite-ignore */ p);
  return (fn = typeof (mod.next ?? mod.default) === "function" ? (mod.next ?? mod.default) : null);
}
export const _resetPhaseHook = (): void => { fn = undefined; };

/** If the phase changed from `from`, ask the hook what to do and apply its operations (at most 4 hops, so a hook cannot loop). */
export async function runPhaseHook(state: GameState, from: string, event = "state", args?: Record<string, unknown>, session?: Session): Promise<GameState> {
  const h = await load();
  if (!PHASES || (!h && DEAL !== "server" && !ROUTED)) return state;
  let cur = state, prev = from;
  for (let hop = 0; hop < 4; hop++) {
    const to = String(cur.game.phase ?? "");
    if (!to || to === prev) break;
    let out: { ops?: unknown[]; phase?: string } | void;
    if (DEAL === "server") { const d = dealOps(cur, to); if (d.length) { recordDeal(session, cur, d, to); await logHand(session, cur, "deal", { to, ops: d }); const r = applyServerOps(cur, d); cur = r.state; for (const s of r.skipped) console.warn(`deal ${prev}->${to}: ${s}`); if (BETTING === "server" && to === "preflop") { if (!Number(cur.game.hands_played)) await logHand(session, cur, "settings", { small_blind: cur.game.small_blind, big_blind: cur.game.big_blind, ante: cur.game.ante, max_raises: cur.game.max_raises, stack: cur.game.stack, tip_after: cur.game.tip_after, chips: Object.fromEntries(Object.entries(cur.actors).filter(([, a]) => typeof (a as any)?.chips === "number").map(([id, a]) => [id, (a as any).chips])) }); const first = startHand(cur, BLINDS); (cur.game as Record<string, unknown>).bet_log = [first, ...playNpcs(cur)].filter(Boolean); } } }
    if (PAY?.escrow?.releaseOn.includes(prev)) { const lines = releaseEscrow(cur); if (lines.length) { console.log(`escrow released leaving ${prev}`); await logHand(session, cur, "pay", { released: true, leaving: prev }); } } // chips held for what just ended are paid out
    const ro = PHASES[prev]?.routes[to]; // the route's own operations run as soon as the game is in `to`
    if (ro?.length) { const r = applyServerOps(cur, ro); cur = r.state; for (const s of r.skipped) console.warn(`route ${prev}->${to}: ${s}`); }
    if (!h) { prev = to; break; }
    try { out = await h({ from: prev, to, state: cur, event, args }); } catch (e) { console.warn(`phases.hook failed (state kept): ${(e as Error).message}`); break; }
    if (!out) break;
    if (Array.isArray(out.ops) && out.ops.length) { const r = applyServerOps(cur, out.ops); cur = r.state; for (const s of r.skipped) console.warn(`phases.hook ${prev}->${to}: ${s}`); }
    prev = to;
    if (typeof out.phase === "string" && PHASES[out.phase] && out.phase !== to) { cur.game.phase = out.phase; } else break;
  }
  return cur;
}
