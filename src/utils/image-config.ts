import path from "node:path";
import { config, IMENG_PATH } from "./config.js";
import { judgeOver } from "./goals-config.js";
import type { ImagesConfig } from "./types.js";

/** Image generation settings: config.json `images` (off when absent) plus the env vars that protect the machine. */

const posInt = (v: string | undefined, d: number): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };

export const IMAGES: ImagesConfig | null = config.images && typeof config.images === "object" ? (config.images as ImagesConfig) : null;

const DEFAULT_URLS = { comfyui: "http://127.0.0.1:8188", a1111: "http://127.0.0.1:7860", openai: "http://127.0.0.1:8080", ollama: "http://127.0.0.1:11434" } as const;
export const IMAGE_URL = (process.env.IMAGE_URL || IMAGES?.url || (IMAGES ? DEFAULT_URLS[IMAGES.renderer] : "")).replace(/\/+$/, "");
/** Where rendered pictures are written and served from. */
export const IMAGE_DIR = path.resolve(process.env.IMAGE_DIR || "./images");
/** The address people reach this proxy at (used in the picture links). */
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 3001)}`).replace(/\/+$/, "");
export const IMAGE_MAX_BYTES = posInt(process.env.IMAGE_MAX_BYTES, 10 * 1024 * 1024);
export const IMAGE_TIMEOUT_MS = posInt(process.env.IMAGE_TIMEOUT_MS, 10 * 60 * 1000);
/** A reference URL may point at a private or loopback address only when this is set (default: refused). */
export const IMAGE_REF_ALLOW_PRIVATE = ["1", "true", "on"].includes((process.env.IMAGE_REF_ALLOW_PRIVATE ?? "").toLowerCase());

export const IMAGE_SIZE = { width: IMAGES?.size?.width ?? 768, height: IMAGES?.size?.height ?? 768 };
export const IMAGE_MAX_QUEUE = IMAGES?.max_queue ?? 3;
export const IMAGE_LEASE = { unloadNarrator: IMAGES?.lease?.unload_narrator ?? true, freeRenderer: IMAGES?.lease?.free_renderer ?? true };

const TEXTS: Record<string, string> = {
  busy: "A picture is already being made. Try again when it is done.",
  queue_full: "Too many pictures are waiting. Try again in a bit.",
  failed: "The picture could not be made.",
  bad_format: "I can only use PNG, JPEG or WebP images; that file is {kind}.",
  unsafe: "That picture is not allowed here.",
  safety_down: "Pictures cannot be checked right now, so none is used.",
  unknown_who: "I don't know who \"{who}\" is.",
  no_game: "There is no game here yet.",
  caption: "{subject}",
  offer_confirm: "Reply yes to make it.",
  yes: "yes,y,yeah,yep,ok,okay,sure",
  keepsake_not_over: "The game is not over yet.",
  keepsake_not_you: "The keepsake is for the person who got the most goals.",
  keepsake_claimed: "You already have your keepsake.",
  keepsake_pick: "Pick your keepsake:",
  keepsake_hint: "Send /keepsake and the number.",
  keepsake_bad: "Pick a number from the list.",
  keepsake_none: "There is no keepsake to offer.",
};
export const imageText = (key: string, vars: Record<string, string> = {}): string =>
  (IMAGES?.texts?.[key] ?? TEXTS[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? "");

/** A file in the game folder, never outside it. */
export function gameFile(rel: string): string | null {
  const p = path.resolve(IMENG_PATH, rel);
  return p === IMENG_PATH || p.startsWith(IMENG_PATH + path.sep) ? p : null;
}

export const OFFER_PREFIX = IMAGES?.ask?.offer ?? "Make an image of";

/** A different judge model for the picture prompt (env IMAGES_JUDGE_*), and for the refine pass (env IMAGES_REFINE_JUDGE_*; defaults to the first). */
export const IMAGE_JUDGE = judgeOver(IMAGES?.judge, "IMAGES");
export const REFINE = IMAGES?.refine ? {
  rules: typeof IMAGES.refine.rules === "string" && IMAGES.refine.rules.trim() ? IMAGES.refine.rules.trim() : "",
  maxWords: Math.min(120, Math.max(10, Math.floor(Number(IMAGES.refine.max_words)) || 40)),
  negations: (Array.isArray(IMAGES.refine.negations) ? IMAGES.refine.negations : ["no", "not", "without", "never"]).filter((w): w is string => typeof w === "string" && /^[\p{L}-]{1,20}$/u.test(w)).map((w) => w.toLowerCase()),
  judge: judgeOver(IMAGES.refine.judge, "IMAGES_REFINE") ?? IMAGE_JUDGE,
} : null;
export const STATE_FIELDS = (IMAGES?.state_fields ?? []).filter((f) => typeof f === "string" && /^[\w-]{1,40}$/.test(f));
export const GAME_FIELDS = (IMAGES?.game_fields ?? []).filter((f) => typeof f === "string" && /^[\w-]{1,40}$/.test(f));
export const KEEP_FIELDS = (IMAGES?.keep_fields ?? []).filter((f) => typeof f === "string" && /^[\w-]{1,40}$/.test(f));
export const KEEPSAKE = IMAGES?.keepsake ? {
  options: IMAGES.keepsake.options === "judge" ? ("judge" as const) : (Array.isArray(IMAGES.keepsake.options) ? IMAGES.keepsake.options : []).filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 300)),
  theme: typeof IMAGES.keepsake.theme === "string" ? IMAGES.keepsake.theme.slice(0, 400) : "",
  game: typeof IMAGES.keepsake.game === "string" ? IMAGES.keepsake.game : String(config.model_id ?? ""),
  maxOptions: Math.min(6, Math.max(1, Math.floor(Number(IMAGES.keepsake.max_options)) || 3)),
} : null;
