import { config } from "./config.js";

/** config.json `goals`: secret goals people write down in the game's private channel (off unless the block exists). See docs/IMENG-MAKING.md. */

const num = (v: unknown, d: number, lo: number, hi: number): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const word = (v: unknown, d: string): string => (typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : d);

export interface JudgeOver { model?: string; url?: string; api?: "ollama" | "openai"; numCtx?: number }
/** A judge setting of one feature: config.json `judge` {model, url, api, num_ctx}; the env (<PREFIX>_JUDGE_MODEL, _URL, _API) wins. Undefined = the game's usual judge. */
export function judgeOver(raw: unknown, prefix: string): JudgeOver | undefined {
  const j: any = raw && typeof raw === "object" ? raw : {};
  const env = process.env;
  const model = env[`${prefix}_JUDGE_MODEL`] || (typeof j.model === "string" ? j.model : "") || undefined;
  const url = env[`${prefix}_JUDGE_URL`] || (typeof j.url === "string" ? j.url : "") || undefined;
  const api = (env[`${prefix}_JUDGE_API`] || j.api) === "openai" ? "openai" : (env[`${prefix}_JUDGE_API`] || j.api) === "ollama" ? "ollama" : undefined;
  const numCtx = Number(j.num_ctx) > 0 ? Math.floor(Number(j.num_ctx)) : undefined;
  return model || url || api || numCtx ? { model, url, api, numCtx } : undefined;
}

const g: any = config.goals && typeof config.goals === "object" && !Array.isArray(config.goals) ? config.goals : null;
export type GoalHost = "blind" | "own" | "all";
export type GoalReward = "award" | "points" | "keepsake";
export const GOALS = g ? {
  /** What the game calls the private channel's device (told to the narrator and used in replies). */
  device: typeof g.device === "string" && g.device.trim() ? g.device.trim().slice(0, 60) : "notebook",
  min: num(g.min, 1, 0, 10),
  max: num(g.max, Math.max(1, num(g.min, 1, 0, 10)), 1, 10),
  /** blind: the narrator is told no goals; own: the goals of the characters it plays (NPCs); all: everyone's. */
  host: (["own", "all"].includes(g.host) ? g.host : "blind") as GoalHost,
  reward: (["points", "keepsake"].includes(g.reward) ? g.reward : "award") as GoalReward,
  points: num(g.points, 1, 1, 100),
  /** reward "keepsake": who may have one: the person with the most goals (a tie gives nobody), or anyone who reached at least one. */
  keepsakeFor: (g.keepsake_for === "done" ? "done" : "leader") as "leader" | "done",
  scoreField: word(g.score_field, "score"),
  /** Goals are accepted from a private note only in this phase (any time when empty). */
  capturePhase: typeof g.capture_phase === "string" ? g.capture_phase : "",
  /** NPCs with too few goals get one invented by the judge (after this many rounds). */
  npc: (g.npc === "invent" ? "invent" : "none") as "invent" | "none",
  npcAfter: num(g.npc_after, 1, 0, 100),
  theme: typeof g.theme === "string" ? g.theme.slice(0, 600) : "",
  /** Who sees how many goals each person got: at the end of the game, or always. */
  standings: (g.standings === "always" ? "always" : "end") as "end" | "always",
  /** After the finale the goals of everyone are told (reveal), or never. */
  reveal: (g.reveal === "never" ? "never" : "end") as "end" | "never",
  judge: judgeOver(g.judge, "GOALS"),
  texts: (g.texts && typeof g.texts === "object" ? g.texts : {}) as Record<string, string>,
} : null;

const TEXTS: Record<string, string> = {
  saved: "Written in {device}: {goal}",
  full: "{device} already holds {max} goal(s). Nothing was added.",
  not_here: "Goals are private. Write them in your private chat with the game, not at the table.",
  not_now: "It is not the time for new goals.",
  empty: "Write what you want after /goal.",
  none: "Nothing is written in {device} yet.",
  heading: "In {device}:",
  done: "done",
  open: "not yet",
  standings: "Goals done:",
  winner: "Most goals: {who}.",
  tie: "Nobody got more goals than anyone else.",
  nobody: "Nobody got a goal.",
  reveal: "What everyone secretly wanted:",
  reaction: "{who} has just got what they secretly wanted. Show it in how they look or move (a big smile, a fist pump) and never say why.",
  reasons: "These are reasons people gave privately for what they want. Respect them in the story (for example, do not do to someone what they said they cannot take) and never say or hint who said it.",
  block: "Each person below secretly wants something. Voice the goals of the characters you play and never state or hint at any of them in narration. A goal is reached only when it really happens in the story.",
  unread: "I could not read that just now. Try again, or write it after /goal.",
};
const fill = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
export const goalText = (key: string, v: Record<string, string | number> = {}): string =>
  fill(GOALS?.texts[key] ?? TEXTS[key] ?? key, { device: GOALS?.device ?? "", max: String(GOALS?.max ?? ""), ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) });
export const GOAL_TEXT_KEYS = Object.keys(TEXTS);
