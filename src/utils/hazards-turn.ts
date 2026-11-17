import { HAZARDS, PHASES, PRODUCER } from "./config.js";
import { gatedPhase, gateText } from "./phases.js";
import { runPhaseHook } from "./phase-hook.js";
import { callShelter } from "./random-events.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Session } from "./types.js";

/** The producer's two levers (the owner): /risk <number> scales the chance of a hazard (0 = none, 1 = as written, up to 5), /shelter calls the move to the shelter at once. */
const TEXTS: Record<string, string> = {
  not_owner: "Only the producer (the owner) can do that.", usage: "Use /risk <number from 0 to 5>.", risk_set: "Risk is now {x} times what the table says.", none_left: "The show has already been moved or called, or nothing can be called from here.",
  move_usage: "Use /move <place>.", moved: "The producer has moved the show: it carries on at the new place.", ended: "The producer has ended the show.",
  called: "The producer has called it: everyone is being moved to the shelter.",
};
const say = (k: string, v: Record<string, string> = {}): string => (TEXTS[k] ?? k).replace(/\{(\w+)\}/g, (_m, x: string) => v[x] ?? "");

/** May this person use this producer command? By imeng setting: the owner, or anyone whose actor role is the producer role. */
export function mayProduce(session: Session, who: PlayerRef, name: string): boolean {
  const mode = PRODUCER.commands[name] ?? PRODUCER.who;
  if (session.owner && session.owner.userId === who.userId) return true;
  if (mode !== "role") return false;
  const st = session.snapshots.at(-1);
  const actor = session.room?.players?.[who.userId]?.actor; // the seat this person plays
  return !!st && !!actor && (st.actors[actor] as any)?.role === PRODUCER.role;
}

/** /move <place> and /end: the producer's phase signals. Applied once (the same signal id is ignored), never shown to the table. The imeng's phases.hook decides what follows. */
export async function phaseCommand(name: "move" | "end", arg: string, c: { session: Session; who: PlayerRef; signal?: string }): Promise<string> {
  const s = c.session;
  if (!PHASES || !s.snapshots.length) return "";
  if (!mayProduce(s, c.who, name)) return say("not_owner");
  const st = s.snapshots.at(-1)!;
  const g = st.game as Record<string, unknown>;
  const held = gatedPhase(st, "producer");
  if (held) return gateText(held); // a gated phase cannot be moved by a producer signal
  if (c.signal) { const seen = (s.signals ??= []); if (seen.includes(c.signal)) return ""; seen.push(c.signal); if (seen.length > 50) seen.shift(); }
  const from = String(g.phase ?? "");
  if (name === "move") { if (!arg.trim()) return say("move_usage"); g.moved_to = arg.trim().slice(0, 80); g.phase = PHASES["playing"] ? "playing" : from; }
  else g.phase = PHASES["finale"] ? "finale" : from;
  const next = await runPhaseHook(st, name === "move" && PHASES["relocating"] ? "relocating" : from, name, { place: g.moved_to }, s); // a move always re-enters play from the relocation phase
  s.snapshots[s.snapshots.length - 1] = next;
  return say(name === "move" ? "moved" : "ended");
}

export function hazardCommand(name: "risk" | "shelter", arg: string, c: { session: Session; who: PlayerRef; round: number }): string {
  const s = c.session;
  if (!HAZARDS || !s.snapshots.length) return "";
  if (!mayProduce(s, c.who, name)) return say("not_owner");
  const state = s.snapshots.at(-1)!;
  if (name === "risk") {
    const x = Number(arg.trim());
    if (!Number.isFinite(x) || x < 0 || x > 5) return say("usage");
    (state.game as Record<string, unknown>).hazard_mod = x;
    return say("risk_set", { x: String(x) });
  }
  const next = callShelter(s, state, c.round);
  if (!next) return say("none_left");
  s.snapshots[s.snapshots.length - 1] = next;
  return say("called");
}
