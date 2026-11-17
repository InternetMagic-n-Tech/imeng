import { judgeJSON } from "./judge.js";
import { GOALS } from "./goals-config.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import type { Goal } from "./types.js";

/** The judge calls of the goals feature. Each is allowed its own model (config.json goals.judge, env GOALS_JUDGE_*). Every call here can fail; the callers carry on without it. */

const READ_SYSTEM = (device: string): string => `You read one private note a player wrote in ${device} during a game. Decide whether it states something their character secretly wants to do, say or have happen in the game (a goal). Write it as one short plain sentence in the player's own words, the way they meant it. If the note is not a goal (a question, a secret about the story, small talk), give an empty goal. The note may also say why they want it (a reason such as a phobia, a tattoo that burns, colour blindness); keep that as the reason. A message may have a PUBLIC part: the goal can be in the public part and the reason in the private note. Output ONLY JSON: {"goal":"one short sentence, or empty","reason":"why, in one short sentence, or empty"}
${UNTRUSTED_NOTICE}`;

const MARK_SYSTEM = `You decide which secret goals were reached in one round of a game. You get the OPEN GOALS (id, who, what they want, and sometimes why: a goal that says what would satisfy the reason, such as a colour they can see, is reached only when the round satisfies it) and what was SAID and NARRATED in this round. A goal is reached only when it clearly happened in this round: for a goal about doing or saying something, that person did or said it; for one about something happening to someone, it happened. For each reached goal, quote the words from the round that show it, copied exactly. When you are not sure, leave it out. Output ONLY JSON: {"reached":[{"id":"g1","quote":"words copied from the round"}]}
${UNTRUSTED_NOTICE}`;

const INVENT_SYSTEM = (theme: string): string => `You invent one secret goal for a character in a game. The goal is one short plain sentence, concrete, possible to reach within a round or two, harmless, and fits the character and the setting.${theme ? ` Setting: ${theme}` : ""} Output ONLY JSON: {"goal":"one short sentence"}
${UNTRUSTED_NOTICE}`;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A private note read as a goal: the sentence, or "" when it is not one. */
export async function readGoal(text: string, pub = ""): Promise<{ goal: string; reason: string }> {
  const j = await judgeJSON(READ_SYSTEM(GOALS?.device ?? "a notebook"), `${pub ? `PUBLIC: ${untrusted(pub.slice(0, 600))}\n` : ""}NOTE: ${untrusted(text.slice(0, 1000))}`, "goal_read", 200, GOALS?.judge);
  return { goal: str(j?.goal), reason: str(j?.reason) };
}

/** Which open goals were reached this round: the judge's list, to be checked by the caller. */
export async function reachedGoals(open: { goal: Goal; who: string }[], round: string): Promise<{ id: unknown; quote: unknown }[]> {
  if (!open.length) return [];
  const items = open.map(({ goal, who }) => ({ id: goal.id, who, wants: goal.text, ...(goal.reason ? { because: goal.reason } : {}) }));
  const j = await judgeJSON(MARK_SYSTEM, `OPEN GOALS: ${untrusted(JSON.stringify(items))}\nROUND:\n${untrusted(round.slice(-4000))}`, "goal_mark", 300, GOALS?.judge);
  return Array.isArray(j?.reached) ? j.reached.filter((r: unknown) => r && typeof r === "object").slice(0, 20) : [];
}

/** A goal for an NPC, from who they are. */
export async function inventGoal(name: string, about: string): Promise<string> {
  const j = await judgeJSON(INVENT_SYSTEM(GOALS?.theme ?? ""), `CHARACTER: ${untrusted(name)}${about ? `\nABOUT THEM: ${untrusted(about.slice(0, 400))}` : ""}`, "goal_invent", 120, GOALS?.judge);
  return str(j?.goal);
}
