import { seatActor } from "./seats.js";
import { minToPlay, dealtIn } from "./poker-seats.js";
import { act, startHand, playNpcs, rollOn, leave } from "./poker-bet.js";
import { runPhaseHook } from "./phase-hook.js";
import { logHand } from "./hand-log.js";
import { npcTips } from "./tips.js";
import { PHASES } from "./config.js";
import { gatedPhase, gateText } from "./phases.js";
import { stateNow, unavailableText } from "./db-state.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

const NAMES: Record<string, string> = { check: "check", call: "call", raise: "raise", fold: "fold", allin: "allin", deal: "deal" };
export const BET_COMMANDS = Object.keys(NAMES);

/** What the table is told when the server turns cards: the board in words. */
const boardLine = (s: GameState, phase: string): string => { const b = ((s.actors.table as any)?.board ?? []) as string[]; return b.length ? ` ${phase[0].toUpperCase() + phase.slice(1)}: ${b.join(" ")}.` : ""; };

const STREETS = ["preflop", "flop", "turn", "river"];

/** What the table does by itself after an action: the phase hook turns the cards, NPCs play, streets run out. Appends to `lines`; returns the latest state. */
async function runOn(s: Session, from: string, lines: string[]): Promise<void> {
  let st = s.snapshots.at(-1)!;
  for (let hop = 0; hop < 12; hop++) {
    const now = String(st.game.phase ?? "");
    if (now !== from) {
      st = await runPhaseHook(st, from, "state", undefined, s);
      s.snapshots[s.snapshots.length - 1] = st;
      if (now !== "showdown") lines.push(boardLine(st, now).trim()); else lines.push(...npcTips(st));
      from = now;
    }
    if (!st.game.current_actor && STREETS.includes(now)) { const t = rollOn(st); if (t) { lines.push(t); continue; } }
    const npc = playNpcs(st);
    if (npc.length) { lines.push(...npc); continue; }
    break;
  }
  s.snapshots[s.snapshots.length - 1] = st;
}

/** One action by `seat` on the session's latest snapshot, then everything the table does by itself (NPC plays, the next street's cards, the roll-out). Returns the lines and whether the action was taken. */
async function play(s: Session, seat: string, name: string, noSense = false): Promise<{ ok: boolean; lines: string[] }> {
  const st = s.snapshots.at(-1)!, from = String(st.game.phase ?? "");
  const r = act(st, seat, name, { noSense });
  const lines: string[] = [r.text];
  if (!r.ok) return { ok: false, lines };
  await logHand(s, st, "bet", { seat, action: name, text: r.text });
  await runOn(s, from, lines);
  return { ok: true, lines: lines.filter(Boolean) };
}

/** A seated player leaves during a hand: the seat folds, or stays in for what it bet (game.leave_rule "split"), then the table plays on. Returns what to tell the table, or "". */
export async function leaveSeat(s: Session, seat: string): Promise<string> {
  const st = s.snapshots.at(-1);
  if (!st?.actors[seat]) return "";
  const from = String(st.game.phase ?? ""), text = leave(st, seat, String(st.game.leave_rule ?? "fold"));
  if (!text) return "";
  const lines = [text];
  await logHand(s, st, "bet", { seat, action: "leave", text });
  await runOn(s, from, lines);
  return lines.filter(Boolean).join(" ");
}

/** /deal: a seated player starts the next hand from a phase that leads to `preflop` (the narrator's announcement need not be read right). The server deals and posts the blinds through the phase hook. */
async function dealCommand(s: Session, seat: string): Promise<string> {
  const st = s.snapshots.at(-1)!, from = String(st.game.phase ?? "");
  const held = gatedPhase(st, "deal");
  if (held) return gateText(held);
  if (!PHASES?.[from]?.next.includes("preflop")) return from === "preflop" || STREETS.includes(from) ? "A hand is already being played." : "No hand can start right now.";
  const need = minToPlay(st);
  if (need && !dealtIn(st, seat)) return `You need at least ${need} chips to be dealt in.`;
  const live = Object.keys(st.actors).filter((id) => dealtIn(st, id)).length;
  if (live < 2) return need ? `At least two players with ${need} chips or more are needed.` : "At least two players with chips are needed.";
  st.game.phase = "preflop"; st.game.hand = (Number(st.game.hand) || 0) + 1;
  s.snapshots[s.snapshots.length - 1] = await runPhaseHook(st, from, "state", undefined, s);
  const now = s.snapshots.at(-1)!;
  const log = Array.isArray(now.game.bet_log) ? (now.game.bet_log as string[]) : [];
  return [`Hand ${now.game.hand} begins and the cards are out.`, ...log].join(" ");
}

/** /check /call /raise /fold /allin: a real player's betting action, kept in code. Returns the reply for the table (the NPCs' plays, the next street's cards and who is to act are in it). */
export async function betCommand(name: string, c: { session: Session; who: PlayerRef }): Promise<string> {
  const s = c.session, st = s.snapshots.at(-1);
  if (!st) return "";
  if (!(await stateNow()).ok) return unavailableText(); // the bookkeeper is away: the table pauses, nothing is dealt or bet by anyone else
  const seat = seatActor(s, c.who.userId);
  if (!seat || !st.actors[seat]) return "You are not seated at this table.";
  if (name === "deal") return dealCommand(s, seat);
  return (await play(s, seat, name)).lines.join(" ");
}

/** The shot clock under server betting: a round line "(not heard from ...)" for the seat that is to act folds it in code (the narrator cannot write status). Returns the line for the narrator, or "". */
export async function autoFold(s: Session, roundText: string): Promise<string> {
  const st = s.snapshots.at(-1), cur = st?.game.current_actor;
  if (!st || typeof cur !== "string" || !STREETS.includes(String(st.game.phase ?? ""))) return "";
  const timedOut = roundText.split("\n").some((l) => { const m = /^\[.+? \(actors\.([^)]+)\)\]\s*\(not heard from/.exec(l); return m?.[1] === cur; });
  if (!timedOut) return "";
  const r = await play(s, cur, "fold", true); // a timeout says nothing about how they play
  return r.ok ? `NOTE: The shot clock folded ${String((st.actors[cur] as any)?.name ?? cur)}; the server did it and says: ${r.lines.join(" ")} Narrate it; do not change chips, bets or status.` : "";
}

export { startHand };
