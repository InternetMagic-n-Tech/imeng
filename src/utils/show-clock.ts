import { judgeJSON } from "./judge.js";
import { SHOW_CLOCK } from "./config.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";

const JUMP_PROMPT = `You read one round of a TV show game and say how many extra minutes of SHOW time a time jump inside the story took ("we wait until sunrise", "let's take a long break", "skip to the next day"). Only time inside the story counts. Talk about the real world (the player says brb, my battery, I have to go for ten minutes) counts for nothing. An ordinary action with no jump is 0.
Output ONLY JSON: {"minutes": a whole number}.`;

/** Extra show minutes for a free-form time jump in the round: 0 when none, when the judge is off or fails, never above jump_max. */
export async function timeJump(said: string): Promise<number> {
  if (!SHOW_CLOCK?.judge || said.trim().length < 5) return 0;
  try {
    const v = await judgeJSON(`${JUMP_PROMPT}\n\n${UNTRUSTED_NOTICE}`, `<round>${untrusted(said.slice(0, 2000))}</round>`, "show_clock", 40);
    const n = Math.floor(Number(v?.minutes));
    return Number.isFinite(n) && n > 0 ? Math.min(n, SHOW_CLOCK.jumpMax) : 0;
  } catch { return 0; }
}
