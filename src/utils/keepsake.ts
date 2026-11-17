import { GOALS } from "./goals-config.js";
import { IMAGES, KEEPSAKE, imageText } from "./image-config.js";
import { goalsOf, leader, storeOf } from "./goals.js";
import { makePicture } from "./images.js";
import { judgeJSON } from "./judge.js";
import { REFINE, IMAGE_JUDGE } from "./image-config.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { placeOf } from "./goals-turn.js";
import type { RenderIO } from "./image-adapters.js";
import type { GameState, Session, Visuals } from "./types.js";

/**
 * The keepsake (goals.reward "keepsake"): after the game, the person who earned it picks one of the game's options and has it drawn, with their own
 * recorded looks. The options are written in config.json (templates with {name}, {game} and any actor field) or proposed once by a judge that knows
 * the setting (a social media thumbnail, a small trophy). Code decides who may have one and that it is made only once.
 */

const OPTIONS_SYSTEM = (n: number): string => `You propose keepsakes for the person who won a game: a picture they can keep. Propose ${n} different ones that fit the setting (if there is social media, something to post; if not, something to hold or hang, like a small trophy). Each is one short phrase describing the picture, may use {name} for the winner's name and {game} for the game's name. Output ONLY JSON: {"options":["phrase","phrase"]}
${UNTRUSTED_NOTICE}`;

const claimedOf = (s: Session): Visuals["keepsake"] & { claimed: Record<string, string> } => { const v = (s.visuals ??= { seeds: {}, refs: {} }); return (v.keepsake ??= { claimed: {} }); };

/** Fill {name}, {game} and actor fields in a template; an unknown word is left out. */
export function fillKeepsake(tpl: string, state: GameState, actor: string): string {
  const a = state.actors[actor] ?? {};
  return tpl.replace(/\{([\w-]+)\}/g, (_m, k: string) => {
    if (k === "game") return KEEPSAKE?.game ?? "";
    const v = k === "name" ? a.name ?? actor : a[k];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" || typeof v === "number" ? String(v) : "";
  }).replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

/** The options: the game's list, or what the judge proposed the first time (kept for the session). */
async function optionsOf(s: Session, state: GameState, actor: string): Promise<string[]> {
  if (!KEEPSAKE) return [];
  if (KEEPSAKE.options !== "judge") return KEEPSAKE.options;
  const k = claimedOf(s);
  if (!k.options) {
    try {
      const j = await judgeJSON(OPTIONS_SYSTEM(KEEPSAKE.maxOptions), `SETTING: ${untrusted(KEEPSAKE.theme || GOALS?.theme || KEEPSAKE.game)}\nWINNER: ${untrusted(String(state.actors[actor]?.name ?? actor))}`, "keepsake_options", 250, REFINE?.judge ?? IMAGE_JUDGE);
      k.options = Array.isArray(j?.options) ? j.options.filter((o: unknown): o is string => typeof o === "string" && !!o.trim()).map((o: string) => o.trim().slice(0, 300)).slice(0, KEEPSAKE.maxOptions) : [];
    } catch (e) { console.warn("keepsake: options not proposed:", (e as Error).message); return []; }
  }
  return k.options ?? [];
}

export interface KeepsakeCtx { arg: string; mp: "solo" | "table" | "private"; solo: Session; table: Session | null; userId: string; io?: RenderIO; random?: () => number }

/** /keepsake lists the options for the person who earned one; /keepsake <number> has it drawn (once). */
export async function keepsakeTurn(c: KeepsakeCtx): Promise<string> {
  if (!GOALS || GOALS.reward !== "keepsake" || !IMAGES || !KEEPSAKE) return imageText("keepsake_none");
  const p = placeOf(c);
  if (!p) return imageText("keepsake_none");
  const { s, state, actor } = p;
  const over = s.wrapUp !== undefined && s.snapshots.length - 1 >= s.wrapUp;
  if (!over) return imageText("keepsake_not_over");
  const st = storeOf(s);
  const earned = GOALS.keepsakeFor === "done" ? goalsOf(st, actor).some((g) => g.done) : leader(st, state).id === actor;
  if (!earned) return imageText("keepsake_not_you");
  const k = claimedOf(s);
  if (k.claimed[actor]) return imageText("keepsake_claimed");
  const options = await optionsOf(s, state, actor);
  if (!options.length) return imageText("keepsake_none");
  const n = Number(c.arg.trim());
  if (!c.arg.trim()) return [imageText("keepsake_pick"), ...options.map((o, i) => `${i + 1}. ${fillKeepsake(o, state, actor)}`), imageText("keepsake_hint")].join("\n");
  if (!Number.isInteger(n) || n < 1 || n > options.length) return imageText("keepsake_bad");
  const subject = fillKeepsake(options[n - 1], state, actor);
  const out = await makePicture({ name: "draw", arg: subject }, { session: s, state, narration: "", forceActor: actor, io: c.io, random: c.random });
  if (out.startsWith("![")) k.claimed[actor] = subject;
  return out;
}
