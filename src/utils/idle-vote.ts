import { MULTIPLAYER } from "./config.js";
import { gatedPhase, gateText } from "./phases.js";
import { parseDurationMs } from "./durations.js";
import { activePlayers, blocking, type PlayerRef, type StepCtx } from "./multiplayer.js";
import type { Session } from "./types.js";

/**
 * An idle vote (multiplayer.idle_vote). The table agrees at registration how long is too long (state `imeng.idle_after`, say "3m"). Once the people the game is waiting on have held it
 * up past that, any other player may type /idle; when more than half of the others (at least min_votes, never more than exist) have, each blocker is moved on exactly as the game's
 * default does it, and sits out until they speak again. Real time is checked by code; a vote before the limit does nothing but say how long is left.
 */
const TEXTS: Record<string, string> = {
  off: "There is no idle vote in this game.", no_limit: "The table has not agreed on an idle limit, so nobody can be moved on.", nobody: "Nobody is holding the table up.",
  too_soon: "Not yet: the limit is {limit} and it has been {so_far}. Try again in {left}.", self: "You are the one the table is waiting for: just act, or say you are stepping away.",
  voted: "Vote counted for moving {names} on: {votes} of {need} needed.", done: "{names} held the table up past {limit} and has been moved on (their default action; they sit out until they speak).",
};
const fill = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
const say = (k: string, v: Record<string, string> = {}): string => fill(TEXTS[k] ?? k, v);
const mins = (ms: number): string => { const s = Math.max(1, Math.round(ms / 1000)); return s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`; };

const at = (state: any, path: string): unknown => path.split(".").reduce((o, k) => (o && typeof o === "object" ? (o as any)[k] : undefined), state);

export function idleVote(session: Session, voter: PlayerRef, ctx: StepCtx): string {
  const cfg = MULTIPLAYER, room = session.room;
  if (!cfg?.idleVote || !room) return say("off");
  const state = session.snapshots.at(-1)!;
  const held = gatedPhase(state);
  if (held) return gateText(held); // a gated phase cannot be voted past
  const raw = at(state, cfg.idleVote.limit);
  const limitMs = typeof raw === "string" ? parseDurationMs(raw) : typeof raw === "number" && raw > 0 ? raw * 60_000 : null; // a bare number is minutes
  if (!limitMs) return say("no_limit");
  const active = activePlayers(room, cfg, ctx.now);
  const blockers = blocking(room, cfg, ctx, active).filter((p) => !p.away);
  if (!blockers.length) return say("nobody");
  if (blockers.some((p) => p.userId === voter.userId)) return say("self");
  const waited = ctx.now - (room.openedAt ?? ctx.now);
  if (waited < limitMs) return say("too_soon", { limit: mins(limitMs), so_far: mins(waited), left: mins(limitMs - waited) });
  const others = active.filter((p) => !blockers.some((b) => b.userId === p.userId) && !p.frozen && !p.away).length;
  const need = Math.min(others, Math.max(cfg.idleVote.minVotes, Math.floor(others / 2) + 1));
  const votes = (room.idleVotes ??= []);
  if (!votes.includes(voter.userId)) votes.push(voter.userId);
  const names = blockers.map((p) => p.name).join(", ");
  if (votes.length < need) return say("voted", { names, votes: String(votes.length), need: String(need) });
  for (const p of blockers) { // the same thing the game's own timeout does
    if (!room.talk.some((t) => t.userId === p.userId)) room.talk.push({ userId: p.userId, text: cfg.defaultAction, auto: true });
    if (!room.confirmed.includes(p.userId)) room.confirmed.push(p.userId);
    if (cfg.turns === "judged" && room.awaiting) room.awaiting = room.awaiting.filter((id) => id !== p.userId);
    p.away = { realAt: ctx.now, gameAt: ctx.game };
  }
  room.idleVotes = [];
  return say("done", { names, limit: mins(limitMs) });
}
