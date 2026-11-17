import { judgeJSON } from "./judge.js";
import { OFF_PHASE, QUESTION } from "./config.js";
import { phaseActions, phaseOf } from "./phases.js";
import { dbg } from "./debug.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import type { GameState } from "./types.js";

/**
 * The off-phase gate. A phase that lists `actions` only lets a player's words do those things; a message that matches none of them is an off-phase
 * message and gets the game's fixed reply (config.json `off_phase`) with no narrator call and no change to the state. A small judge reads the message
 * against the action list. If the judge fails the message goes through (the op path gate still holds), so a judge outage never freezes the game.
 */
const PROMPT = `You decide what a player's message is doing in an interactive game. Below are the actions the game accepts right now. Choose the one the message attempts, or "none" if it is chatter, a question to someone else, a joke, or anything that does not attempt one of them. Questions to the game master about what is happening, and in-character speech, count as "talk" only if "talk" is listed.
Output ONLY JSON like {"action":"attack"} using one listed name or "none".`;

export const pickOffPhase = (): string => OFF_PHASE.texts[Math.floor(Math.random() * OFF_PHASE.texts.length)]!;

/** Does the judge's answer name one of the listed actions? A small judge often answers with a word from an action's description ("attack" for "fight: attack, defend, ...") or a near word; only "none" and an answer that cannot be tied to a listed action are off-phase. Bounded: the answer can only select a listed action. */
export function actionFits(answer: unknown, acts: { name: string; describe: string }[]): boolean {
  if (typeof answer !== "string") return true; // no usable verdict: the message is let through, as for a judge failure
  const a = answer.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!a || a === "none") return false;
  if (acts.some((x) => x.name.toLowerCase().replace(/[_-]+/g, " ") === a)) return true;
  const word = new RegExp(`(^|[^\\p{L}])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu");
  const hits = acts.filter((x) => word.test(x.describe));
  if (hits.length === 1) return true;
  return acts.length === 1; // one action in this phase: any attempt the judge names is that action
}

/** True when the message is off-phase: the phase lists actions and none of them fits. */
export async function isOffPhase(state: GameState, message: string): Promise<boolean> {
  const acts = phaseActions(state);
  if (!acts.length || !message.trim()) return false;
  try {
    const v = await judgeJSON(`${PROMPT}\n\n${UNTRUSTED_NOTICE}`, `PHASE: ${phaseOf(state)}\nACTIONS:\n${acts.map((a) => `- ${a.name}: ${a.describe}`).join("\n")}\n\n<player_message>${untrusted(message.slice(0, 500))}</player_message>`, "gate", 60);
    const off = typeof v?.action === "string" && !actionFits(v.action, acts);
    dbg("phases")("gate: %s -> %s", phaseOf(state), v?.action);
    return off;
  } catch (e) { console.warn("phase gate failed (message let through):", (e as Error).message); return false; }
}

/** The open-question gate: the reply for someone who is not the one asked, or null when the message may be read. `speaker` is the sender's actor id. */
export function askedGate(state: GameState, speaker: string): string | null {
  if (!QUESTION) return null;
  const asked = state.game[QUESTION.field];
  if (typeof asked !== "string" || !asked || asked === speaker || !state.actors[asked]) { delete state.game.asked_blocks; return null; }
  if ((state.game.exited_game || []).some((e) => e.id === asked)) return null; // the one asked has left: the question is dead
  // A question that never gets cleared must not lock the table: after two refusals in a row it is dropped and the message is read.
  const blocks = Number(state.game.asked_blocks) || 0;
  if (blocks >= 2) { delete state.game[QUESTION.field]; delete state.game.asked_blocks; return null; }
  state.game.asked_blocks = blocks + 1;
  return QUESTION.text.replace(/\{name\}/g, String(state.actors[asked]?.name || asked));
}
