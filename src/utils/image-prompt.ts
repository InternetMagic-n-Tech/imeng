import { judgeJSON } from "./judge.js";
import { judgeView } from "./state.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { IMAGES, IMAGE_JUDGE, STATE_FIELDS, GAME_FIELDS } from "./image-config.js";
import type { GameState } from "./types.js";

/** The judge (a small model) turns a request and the story so far into one picture prompt. Code puts the fixed style, positive and negative parts around it. */

const SYSTEM = `You write one image prompt for a Stable Diffusion model. Output ONLY JSON: {"prompt":"<comma separated visual phrases, at most 60 words>","actor":"<the id of the one character the picture is mainly of, or null>"}.
Describe only what can be seen, using only the facts you are given (the request, the narration and the recorded characters). No text or letters in the picture, no real people, no story or dialogue. Keep a character's described looks exactly as recorded.
${UNTRUSTED_NOTICE}`;

export interface PromptInput { kind: "scene" | "portrait"; subject: string; narration: string; state: GameState; actor?: string }
export interface Written { prompt: string; actor?: string }

/** What the writer may see of the state: the judge's view of each actor, plus the fields the game lists (images.state_fields, images.game_fields). */
function recorded(state: GameState, actors: Record<string, Record<string, unknown>>): unknown {
  if (!STATE_FIELDS.length && !GAME_FIELDS.length) return actors;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, a] of Object.entries(state.actors)) {
    const extra = Object.fromEntries(STATE_FIELDS.filter((f) => a?.[f] !== undefined && a[f] !== null && a[f] !== "").map((f) => [f, a[f]]));
    out[id] = { ...(actors[id] ?? {}), name: a?.name, ...extra };
  }
  const game = Object.fromEntries(GAME_FIELDS.filter((f) => state.game[f] !== undefined && state.game[f] !== null && state.game[f] !== "").map((f) => [f, state.game[f]]));
  return GAME_FIELDS.length ? { actors: out, game } : out;
}

export async function writePrompt(i: PromptInput): Promise<Written> {
  const fallback = i.subject || i.narration.slice(0, 300);
  try {
    const t0 = Date.now();
    const view = judgeView(i.state);
    const content = `Kind: ${i.kind}${i.actor ? ` of the character ${i.actor}` : ""}\n<player_message>${untrusted(i.subject || "(the current scene)")}</player_message>\n<narration>${untrusted(i.narration.slice(-1500))}</narration>\n<recorded>${untrusted(JSON.stringify(recorded(i.state, view.actors)).slice(0, 3000))}</recorded>`;
    const j = await judgeJSON(SYSTEM, content, "image_prompt", 250, IMAGE_JUDGE);
    console.log(`image prompt written in ${Date.now() - t0} ms`);
    const prompt = typeof j?.prompt === "string" ? j.prompt.trim().slice(0, 600) : "";
    const actor = typeof j?.actor === "string" && i.state.actors[j.actor] ? j.actor : i.actor;
    return { prompt: prompt || fallback, actor };
  } catch (e) {
    console.warn("image prompt fell back to the plain request:", (e as Error).message);
    return { prompt: fallback, actor: i.actor };
  }
}

/** style + the written prompt + positive, skipping empty parts. */
export const composePositive = (scene: string): string => [IMAGES?.prompts?.style, scene, IMAGES?.prompts?.positive].filter(Boolean).join(", ");
