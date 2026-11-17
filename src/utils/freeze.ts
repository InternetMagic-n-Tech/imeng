import { USER_ID } from "./config.js";
import { FREEZE, freezeText } from "./identity-config.js";
import { resolveActor } from "./images.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

/**
 * /freeze and /unfreeze: a character is set aside (someone is in the bathroom, or went to the other app). Game.json `freeze` says how: `skip` (the
 * table does not wait and the narrator leaves them out), `npc` (the narrator plays them) or `inert` (present but still). A returning player may be
 * shown the public narration they missed (`catch_up: public`); whispers and private notes are never in it, because they are not in the room's
 * transcript. The state is kept per actor in session.frozen, so an NPC can be frozen the same way.
 */

const roomPlayerOf = (s: Session, actor: string) => (s.room ? Object.values(s.room.players).find((p) => p.actor === actor) : undefined);
const nameOf = (state: GameState, actor: string, session?: Session): string => {
  const p = Object.values(session?.room?.players ?? {}).find((x) => x.actor === actor);
  return String(p?.name || state.actors[actor]?.name || actor);
};

export interface FreezeCtx { session: Session; state: GameState; who: PlayerRef; arg: string; round: number; now: number; game?: number }

/** The actor a command is about: the player's own, or (when the game allows it) one named. */
function target(c: FreezeCtx): { actor: string } | { error: string } {
  if (!c.arg.trim()) {
    const own = c.session.room?.players[c.who.userId]?.actor ?? (c.session.room ? undefined : USER_ID);
    if (!c.session.room || !own) return { error: freezeText("solo") };
    return { actor: own };
  }
  if (FREEZE!.others !== "anyone") return { error: freezeText("not_allowed") };
  const actor = resolveActor(c.state, c.arg);
  return actor ? { actor } : { error: freezeText("unknown_who", { who: c.arg.trim() }) };
}

/** The public narration since a round, newest part last (what a returning player may read). */
export function missedStory(s: Session, sinceRound: number, max = FREEZE!.catchChars): string {
  const text = (s.room?.history ?? []).slice(sinceRound * 2).filter((m) => m.role === "assistant").map((m) => String(m.content).trim()).filter(Boolean).join("\n\n");
  return text.length > max ? "…" + text.slice(text.length - max) : text;
}

export function freezeTurn(cmd: "freeze" | "unfreeze", c: FreezeCtx): string {
  const t = target(c);
  if ("error" in t) return t.error;
  const s = c.session, name = nameOf(c.state, t.actor, s);
  const rp = roomPlayerOf(s, t.actor);
  s.frozen ??= {};
  if (cmd === "freeze") {
    if (!s.frozen[t.actor]) s.frozen[t.actor] = { at: c.now, round: s.room?.rounds ?? c.round, gameAt: c.game, kind: rp ? "player" : "npc" };
    if (rp) rp.frozen = true;
    return freezeText("frozen", { who: name });
  }
  const f = s.frozen[t.actor];
  if (!f) return freezeText("not_frozen", { who: name });
  delete s.frozen[t.actor];
  if (rp) rp.frozen = false;
  const aware = FREEZE!.catchUp === "public";
  (s.freezeNotes ??= []).push(`${name} is back and ${aware ? "knows what everyone saw while they were frozen (not whispers or private notes)" : "does not know what happened while they were frozen"}.`);
  const own = rp && rp.userId === c.who.userId;
  const story = aware && own ? missedStory(s, f.round) : "";
  return freezeText("unfrozen", { who: name }) + (story ? "\n\n" + freezeText("catch_up", { story }) : "");
}

const defaultText = (mode: "skip" | "npc" | "inert"): string => ({
  skip: "{who} is frozen (away from the game): leave {who} out of the scene and do not write their actions or speech.",
  npc: "{who} is frozen (the player is away): you play {who} yourself as an NPC, true to their description, and keep them out of anything that cannot be undone.",
  inert: "{who} is frozen: still present in the scene, silent and unmoving; do not write their actions or speech.",
})[mode];

/** What the narrator is told this round about frozen characters, and about anyone who came back since the last round (shown once). */
export function frozenBlock(s: Session, state: GameState): string {
  if (!FREEZE) return "";
  const lines = Object.keys(s.frozen ?? {}).filter((a) => state.actors[a]).map((a) => "- " + (FREEZE!.text || defaultText(FREEZE!.mode)).replace(/\{who\}/g, nameOf(state, a, s)));
  lines.push(...(s.freezeNotes ?? []).map((n) => "- " + n));
  s.freezeNotes = [];
  return lines.length ? `\n\n## FROZEN (written by the server)\n${lines.join("\n")}` : "";
}

/** npc mode: a frozen player's actor is an NPC while they are away (code-owned, like every controlled_by). */
export function applyControl(state: GameState, s: Session): void {
  if (!FREEZE || FREEZE.mode !== "npc") return;
  for (const [a, f] of Object.entries(s.frozen ?? {})) if (f.kind === "player" && state.actors[a]) state.actors[a].controlled_by = "npc";
}
