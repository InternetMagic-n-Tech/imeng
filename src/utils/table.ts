import { HANDS } from "./config.js";
import { GOALS } from "./goals-config.js";
import { captureNote } from "./goals-turn.js";
import { SYSTEM_PROMPT, KNOWLEDGE } from "./config.js";
import { privateKnowledge } from "./knowledge-judge.js";
import { stateBlock } from "./state.js";
import { completeText } from "./upstream.js";
import { judgeMessage, needsJudge } from "./room-judge.js";
import { applyVerdict, addNote, leaveTable, lastScene } from "./multiplayer.js";
import { unseat } from "./seats.js";
import type { Sink } from "./sink.js";
import type { MultiplayerConfig } from "./config.js";
import type { GameState, Room, Session } from "./types.js";
import type { Hold, PlayerRef } from "./multiplayer.js";

/**
 * The two places the narrator speaks outside a round: a tension beat (while the table waits on someone) and the private chat (a player's own chat with
 * the game, a side channel to the narrator). Both are optional (config.json: multiplayer.tension, multiplayer.private) and fail soft: when the model
 * cannot be reached they fall back to a plain line, never an error.
 */

const clean = (t: string, maxWords: number): string => {
  const words = t.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ").split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
};

const BEAT = (waiting: string[], maxWords: number, spoke?: string, previous?: string): string =>
  `\n\n## TENSION BEAT\nThe story is paused: the table is waiting on ${waiting.join(" and ") || "someone"}. Write ONE short line (at most ${maxWords} words) in the game's voice that keeps the moment alive: show where the declared actions are right now and move them forward by one small beat, building tension. Never resolve an outcome and never decide anything for a player; what is declared stays unresolved.${spoke ? ` If it fits, let the line also catch what ${spoke} just said.` : ""}${previous ? ` Do not repeat the previous beat; move on from it: "${previous}".` : ""} Output only the line: no quotes, no labels, no JSON, no state.`;

/** The state a private answer is written from: other people's private cards (`private_hands.field`) are blank, so the narrator cannot hand one player another's hand. */
export function hideOthersHands(state: GameState, actor: string): GameState {
  if (!HANDS) return state;
  const c = structuredClone(state);
  for (const [id, a] of Object.entries(c.actors)) if (id !== actor && a && Array.isArray((a as Record<string, unknown>)[HANDS.field])) (a as Record<string, unknown>)[HANDS.field] = [];
  return c;
}

/**
 * The narrator's one short line while the table waits (policy: tension.mode "beats"). Null when beats are off, when the last one was too recent
 * (cooldown), when there is nothing to hold, or when the model fails: the caller then uses the terse status line.
 */
export async function tensionBeat(room: Room, cfg: MultiplayerConfig, hold: Hold | undefined, now: number): Promise<string | null> {
  if (cfg.tension.mode !== "beats" || !hold || (!hold.declared.length && !hold.scene)) return null;
  if (room.beat && now - room.beat.at < cfg.tension.cooldownMs) return null;
  try {
    const declared = hold.declared.length ? hold.declared.map((d) => `${d.who}: ${d.text}`).join("\n") : "(nothing declared yet: hold the scene itself)";
    const sys = SYSTEM_PROMPT + BEAT(hold.waiting, cfg.tension.maxWords, hold.spoke?.who, room.beat?.text);
    const user = `SCENE (last narration): ${hold.scene || "(the story has just begun)"}\nDECLARED, still in motion:\n${declared}${hold.spoke ? `\nJUST SAID: ${hold.spoke.who}: ${hold.spoke.text}` : ""}`;
    const text = clean(await completeText([{ role: "system", content: sys }, { role: "user", content: user }], 120, "tension", 0.8), cfg.tension.maxWords);
    if (!text) return null;
    room.beat = { text, at: now };
    return text;
  } catch (e) {
    console.warn("tension beat failed:", (e as Error).message);
    return null;
  }
}

export interface PrivateArgs {
  sink: Sink;
  who: PlayerRef;
  text: string;
  /** This private chat's own session (its `privateFor` names the table). */
  session: Session;
  table: Session;
  cfg: MultiplayerConfig;
  now: number;
  /** The in-game clock, when the game has one. */
  game?: number;
  state: GameState;
}

const PRIVATE_PROMPT = (name: string, maxWords: number): string =>
  `\n\n## PRIVATE NOTE\n${name} is passing you a private note from their own chat at a shared table. Reply only to ${name}, in the game's voice, in at most ${maxWords} words. Do not advance the story and do not resolve anything for the table. Never reveal other players' secrets or anything the table has not seen, except what belongs to ${name} themselves (their own cards, notes or holdings), which you may tell them. If the note is a plan or an action, say what you will weigh, not what happens. Output only the reply.`;

/**
 * A message in a player's private chat (a new chat of someone seated at a table). It never starts a round. A note is kept and goes into the next
 * round for the narrator only (marked private); "I need a break" steps them away (no reason kept); "if I don't answer in 5 days, ..." is a standing
 * instruction; "leave the table" leaves it. The reply follows multiplayer.private.reply: ack, a short private narrator answer, or none.
 */
export async function privateTurn(a: PrivateArgs): Promise<void> {
  const { sink, who, text, table, cfg, now } = a;
  const priv = cfg.priv!;
  const room = table.room!;
  const me = room.players[who.userId];
  if (!me) { // the table forgot them (it was reset): this chat is an ordinary chat again
    a.session.privateFor = undefined;
    await unseat(who.userId);
    sink.canned("You are not at that table any more. Speak at the table to take your seat again.");
    return;
  }
  me.lastSeen = now;
  const ctx = { now, game: a.game };
  if (cfg.leave.test(text.trim())) {
    leaveTable(room, who.userId, ctx);
    await unseat(who.userId);
    a.session.privateFor = undefined;
    sink.canned("You have left the table. Speak at it again whenever you want to come back.");
    return;
  }

  if (GOALS && text.trim()) { // a goal written down in the private chat is kept as one; the narrator is not told (unless goals.host says so)
    const g = await captureNote({ table, actor: me.actor, text, state: a.state });
    if (g !== null) { sink.canned(g); return; }
  }
  const verdict = needsJudge(room, cfg) ? await judgeMessage(room, cfg, { text: "", secret: text, narration: lastScene(room, 700), me }) : null;
  const ap = applyVerdict(room, me, verdict, cfg, ctx, true);
  const instruction = ap.standingSet || ap.standingCleared || (verdict?.cancelStanding && !text.trim());
  let out: string;
  const kr = KNOWLEDGE && !ap.paused && !ap.standingSet && !ap.standingCleared && !instruction && text.trim() ? await privateKnowledge({ cfg: KNOWLEDGE, table, me, text, state: a.state }) : null;
  if (ap.paused) out = "You have stepped away; the table will not wait for you. Speak when you are back.";
  else if (ap.standingSet) out = "Standing instruction saved. Only you and the DM can see it.";
  else if (ap.standingCleared) out = "Standing instruction withdrawn.";
  else if (kr !== null) out = kr; // a fact or a command: the narrator is not told
  else {
    if (!instruction && text.trim() && priv.narratorSees) addNote(room, who.userId, text.trim());
    out = priv.reply === "none" ? "(noted)" : priv.narratorSees ? "Noted: the DM will weigh it in the next round. Only you can see this." : "Noted. Only you can see this.";
    if (priv.reply === "narrator" && text.trim()) {
      try {
        const sys = SYSTEM_PROMPT + stateBlock(hideOthersHands(a.state, me.actor)) + PRIVATE_PROMPT(me.name, priv.maxWords);
        const t = clean(await completeText([{ role: "system", content: sys }, { role: "user", content: text.trim() }], 300, "private", 0.7), priv.maxWords);
        if (t) out = t;
      } catch (e) { console.warn("private reply failed:", (e as Error).message); }
    }
  }
  if (ap.back) out = `${out} Welcome back.`;
  sink.canned(out);
}
