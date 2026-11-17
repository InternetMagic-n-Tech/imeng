import { seatActor } from "./seats.js";
import crypto from "node:crypto";
import { TIPS } from "./config.js";
import { announce } from "./announce.js";
import { logHand } from "./hand-log.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

/**
 * The house tip jar (config.json `tips`): game.tips (chips, server-owned, never the pot), game.tip_mark (hands dealt at the last tip or cough) and game.tip_idle (hands since), game.tip_notice (the narrator coughs once).
 * A tip is one `amount` (a state path) from a stack, any time, never the last chip. Players, NPCs and the narrator cannot write the jar.
 */
type G = Record<string, any>;
const g = (s: GameState): G => s.game as G;
const fill = (t: string, v: Record<string, string | number>): string => t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const pathVal = (s: GameState, p: string): unknown => p.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), s);

export const tipAmount = (s: GameState): number => (TIPS ? Math.max(0, Math.floor(Number(pathVal(s, TIPS.amount))) || 0) : 0);

function drop(s: GameState, id: string): number {
  const amount = tipAmount(s), a = s.actors[id] as Record<string, any> | undefined;
  if (!amount || !a || a.status === "sitting out" || (Number(a.chips) || 0) <= amount) return 0;
  a.chips = Number(a.chips) - amount;
  g(s).tips = (Number(g(s).tips) || 0) + amount; g(s).tip_mark = Number(g(s).hands_played) || 0; g(s).tip_idle = 0;
  return amount;
}

/** /tip: the player's tip, as the reply for the table. */
export async function tipCommand(session: Session, who: PlayerRef): Promise<string> {
  const st = session.snapshots.at(-1);
  if (!TIPS || !st) return "";
  const seat = seatActor(session, who.userId);
  if (!seat || !st.actors[seat]) return "You are not seated at this table.";
  const amount = drop(st, seat);
  if (!amount) return TIPS.texts.poor;
  await logHand(session, st, "tip", { seat, amount });
  return fill(TIPS.texts.thanks, { name: String((st.actors[seat] as any).name ?? seat), amount, total: Number(g(st).tips) || 0 });
}

/** A winning NPC may tip (npc_chance). Lines for the table; `roll` is injectable for tests. */
export function npcTips(s: GameState, roll: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000): string[] {
  if (!TIPS?.npcChance) return [];
  const out: string[] = [];
  for (const id of Array.isArray(g(s).winners) ? (g(s).winners as string[]) : []) {
    if ((s.actors[id] as any)?.controlled_by !== "npc" || roll() >= TIPS.npcChance) continue;
    const amount = drop(s, id);
    if (amount) out.push(fill(TIPS.texts.npc, { name: String((s.actors[id] as any).name ?? id), amount }));
  }
  return out;
}

const seatedIn = (s: GameState, id: string): boolean => !!s.actors[id] && (s.actors[id] as any).status !== "sitting out" && (Number((s.actors[id] as any).chips) || 0) > tipAmount(s); // someone who could tip

/** After a turn: count the hands dealt, notice a leaver, and when it is time ask the narrator to cough and offer every seated real player a tip, privately. `before` is what the narrator was shown. */
export async function tipsAfterTurn(session: Session, before: GameState, after: GameState): Promise<void> {
  if (!TIPS) return;
  const G = g(after);
  if (g(before).tip_notice) delete G.tip_notice; // it was shown this turn
  const played = Number(G.hands_played) || 0, idle = Math.max(0, played - (Number(G.tip_mark) || 0)); // hands dealt since the last tip or cough (a command may have dealt them)
  const limit = Math.max(1, Math.floor(Number(G.tip_after)) || TIPS.after);
  const left = TIPS.onLeave && Object.keys(after.actors).some((id) => id !== "table" && (after.actors[id] as any)?.status === "sitting out" && (before.actors[id] as any)?.status !== undefined && (before.actors[id] as any).status !== "sitting out");
  G.tip_idle = idle;
  if (!(idle >= limit) && !left) return;
  G.tip_mark = played; G.tip_idle = 0; G.tip_notice = 1;
  const ask = fill(TIPS.texts.ask, { amount: tipAmount(after) });
  for (const p of Object.values(session.room?.players ?? {})) if (seatedIn(after, p.actor) && !p.away) await announce(session, { kind: "tip", to: p.userId, text: ask });
}

/** What the narrator is told on the round after a notice (once). */
export const tipNote = (s: GameState): string => (TIPS && g(s).tip_notice ? `\n\n## DEALER TIP (written by the server)\n${TIPS.texts.cough}` : "");
