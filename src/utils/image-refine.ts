import { judgeJSON } from "./judge.js";
import { REFINE, KEEP_FIELDS, IMAGES } from "./image-config.js";
import { flat, untrusted, UNTRUSTED_NOTICE } from "./text.js";
import type { GameState } from "./types.js";

/**
 * The picture prompt, made fit for a model that understands little language. First code: negations are moved to the negative prompt and recorded
 * values the judge left out are added back. Then, when the game has `images.refine`, a judge (which may be a larger model than the game's usual
 * one) rewrites the prompt as short concrete tags. If it fails or answers nothing usable, the cleaned prompt is used.
 */

const DEFAULT_RULES = (n: number): string => `Write at most ${n} words as short comma separated tags. Subject first (who or what, how many), then what they wear or hold, then the place, then the light. Use only things that can be seen: colours, objects, clothes, poses, faces. Show a feeling as a look or an action (a wide smile, a raised fist), never as a feeling word. Never use a negation: put what to avoid in "avoid". Never use a person's name: describe how they look. Keep every recorded colour and item exactly as given.`;

const SYSTEM = (rules: string): string => `You rewrite one image prompt for a Stable Diffusion model that understands very little language. ${rules} Output ONLY JSON: {"prompt":"comma separated tags","avoid":"comma separated things to keep out of the picture, or empty"}.
${UNTRUSTED_NOTICE}`;

export interface Refined { prompt: string; negative: string }

const tags = (t: string): string[] => t.split(/[,;\n]+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
const dedupe = (xs: string[]): string[] => { const seen = new Set<string>(); return xs.filter((x) => { const k = flat(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };

/** Tags that start with a negation word ("no hats", "without glasses") become negative tags ("hats", "glasses"). */
export function moveNegations(prompt: string, words: string[]): { prompt: string; avoid: string[] } {
  const keep: string[] = [], avoid: string[] = [];
  const re = words.length ? new RegExp(`^(?:${words.join("|")})\\s+(.+)$`, "iu") : null;
  for (const t of tags(prompt)) { const m = re?.exec(t); if (m) avoid.push(m[1]); else keep.push(t); }
  return { prompt: dedupe(keep).join(", "), avoid: dedupe(avoid) };
}

const textOf = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" ? v : "");

/** Recorded values (keep_fields) of the pictured actor that the prompt does not mention: added, so a colour or outfit in the state is never lost. */
export function keepRecorded(prompt: string, state: GameState, actor?: string): string {
  if (!actor || !KEEP_FIELDS.length) return prompt;
  const have = ` ${flat(prompt)} `;
  const add = KEEP_FIELDS.flatMap((f) => tags(textOf(state.actors[actor]?.[f])).filter((v) => !have.includes(` ${flat(v)} `)));
  return add.length ? [prompt, ...dedupe(add)].filter(Boolean).join(", ") : prompt;
}

/** Clean and refine one prompt. Never throws. */
export async function refinePrompt(prompt: string): Promise<Refined> {
  const words = REFINE?.negations ?? ["no", "not", "without", "never"];
  const first = moveNegations(prompt, words);
  let text = first.prompt, avoid = first.avoid;
  if (REFINE) {
    try {
      const t0 = Date.now();
      const j = await judgeJSON(SYSTEM(REFINE.rules || DEFAULT_RULES(REFINE.maxWords)), `PROMPT: ${untrusted(text)}`, "image_refine", 250, REFINE.judge);
      console.log(`image prompt refined in ${Date.now() - t0} ms`);
      const out = typeof j?.prompt === "string" ? j.prompt.trim().slice(0, 600) : "";
      if (out) { const m = moveNegations(out, words); if (m.prompt) { text = m.prompt; avoid = [...avoid, ...m.avoid]; } }
      avoid = [...avoid, ...tags(textOf(j?.avoid))];
    } catch (e) { console.warn("image prompt refine failed, using the unrefined prompt:", (e as Error).message); }
  }
  return { prompt: text, negative: dedupe(avoid).slice(0, 20).join(", ") };
}

export const negativeOf = (extra: string): string => [IMAGES?.prompts?.negative, extra].filter(Boolean).join(", ");
