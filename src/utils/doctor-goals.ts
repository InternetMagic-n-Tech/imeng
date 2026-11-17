import { GOAL_TEXT_KEYS } from "./goals-config.js";

/** Problems in config.json `goals` (empty = fine). */
export function goalProblems(cfg: Record<string, any>): string[] {
  const g = cfg.goals;
  if (g === undefined) return [];
  if (!g || typeof g !== "object" || Array.isArray(g)) return ["goals must be an object"];
  const out: string[] = [];
  const min = g.min ?? 1, max = g.max ?? Math.max(1, Number(min) || 1);
  if (!(Number.isInteger(min) && min >= 0 && min <= 10)) out.push("goals.min must be a whole number from 0 to 10");
  if (!(Number.isInteger(max) && max >= 1 && max <= 10)) out.push("goals.max must be a whole number from 1 to 10");
  else if (Number.isInteger(min) && min > max) out.push("goals.min is above goals.max");
  if (g.host !== undefined && !["blind", "own", "all"].includes(g.host)) out.push('goals.host must be "blind", "own" or "all"');
  if (g.reward !== undefined && !["award", "points", "keepsake"].includes(g.reward)) out.push('goals.reward must be "award", "points" or "keepsake"');
  if (g.npc !== undefined && !["invent", "none"].includes(g.npc)) out.push('goals.npc must be "invent" or "none"');
  if (g.standings !== undefined && !["end", "always"].includes(g.standings)) out.push('goals.standings must be "end" or "always"');
  if (g.reveal !== undefined && !["end", "never"].includes(g.reveal)) out.push('goals.reveal must be "end" or "never"');
  if (g.device !== undefined && (typeof g.device !== "string" || !g.device.trim())) out.push("goals.device must be words (what the game calls the private notebook)");
  if (g.reward === "points") {
    const f = g.score_field ?? "score";
    if (typeof f !== "string" || !/^[\w-]{1,40}$/.test(f)) out.push("goals.score_field must be a field name");
    else if (cfg.actor_template && !(f in cfg.actor_template)) out.push(`goals.score_field "${f}" is not a field of actor_template`);
  }
  if (g.keepsake_for !== undefined && !["leader", "done"].includes(g.keepsake_for)) out.push('goals.keepsake_for must be "leader" or "done"');
  if (g.reward === "keepsake" && cfg.images && !cfg.images.keepsake) out.push("goals.reward \"keepsake\" needs images.keepsake (the options)");
  if (cfg.images?.keepsake && g.reward !== "keepsake") out.push('images.keepsake is only used with goals.reward "keepsake"');
  if (g.reward === "keepsake" && !cfg.images) out.push('goals.reward "keepsake" needs an images block (the keepsake is a picture)');
  if (g.capture_phase !== undefined) {
    const phases = cfg.phases && typeof cfg.phases === "object" ? Object.keys(cfg.phases).filter((k) => k !== "start" && k !== "texts") : [];
    if (!phases.length) out.push("goals.capture_phase needs phases");
    else if (!phases.includes(g.capture_phase)) out.push(`goals.capture_phase "${g.capture_phase}" is not one of the phases`);
  }
  for (const k of Object.keys(g.texts ?? {})) if (!GOAL_TEXT_KEYS.includes(k)) out.push(`goals.texts.${k} is not a known text (${GOAL_TEXT_KEYS.join(", ")})`);
  if (g.judge !== undefined) {
    const j = g.judge;
    if (!j || typeof j !== "object" || Array.isArray(j)) out.push("goals.judge must be an object");
    else {
      if (j.api !== undefined && !["ollama", "openai"].includes(j.api)) out.push('goals.judge.api must be "ollama" or "openai"');
      if (j.model !== undefined && (typeof j.model !== "string" || !j.model)) out.push("goals.judge.model must be a model name");
      if (j.url !== undefined && (typeof j.url !== "string" || !/^https?:\/\//.test(j.url))) out.push("goals.judge.url must be an http(s) address");
    }
  }
  return out;
}

/** Problems in the picture settings added for goals and keepsakes: images.keepsake, refine, state_fields, judge (empty = fine). */
export function imageExtrasProblems(cfg: Record<string, any>): string[] {
  const im = cfg.images;
  if (!im || typeof im !== "object") return [];
  const out: string[] = [];
  const k = im.keepsake;
  if (k !== undefined && !cfg.goals) out.push("images.keepsake needs goals (it is the reward for them)");
  if (k !== undefined) {
    if (!k || typeof k !== "object" || Array.isArray(k)) out.push("images.keepsake must be an object");
    else if (k.options === undefined) out.push('images.keepsake.options is needed: a list of phrases, or "judge"');
    else if (k.options !== "judge" && (!Array.isArray(k.options) || !k.options.length || k.options.some((o: unknown) => typeof o !== "string" || !o.trim()))) out.push('images.keepsake.options must be "judge" or a non-empty list of phrases');
  }
  for (const f of ["state_fields", "game_fields", "keep_fields"]) {
    if (im[f] !== undefined && (!Array.isArray(im[f]) || im[f].some((x: unknown) => typeof x !== "string" || !/^[\w-]{1,40}$/.test(x)))) out.push(`images.${f} must be a list of field names`);
  }
  for (const f of ["state_fields", "keep_fields"]) {
    for (const x of Array.isArray(im[f]) ? im[f] : []) if (cfg.actor_template && typeof x === "string" && !(x in cfg.actor_template)) out.push(`images.${f}: "${x}" is not a field of actor_template`);
  }
  if (im.refine !== undefined) {
    const r = im.refine;
    if (!r || typeof r !== "object" || Array.isArray(r)) out.push("images.refine must be an object");
    else {
      if (r.max_words !== undefined && !(Number.isInteger(r.max_words) && r.max_words >= 10 && r.max_words <= 120)) out.push("images.refine.max_words must be 10 to 120");
      if (r.negations !== undefined && (!Array.isArray(r.negations) || r.negations.some((w: unknown) => typeof w !== "string" || !/^[\p{L}-]{1,20}$/u.test(w)))) out.push("images.refine.negations must be a list of words");
    }
  }
  for (const [label, j] of [["images.judge", im.judge], ["images.refine.judge", im.refine?.judge]] as const) {
    if (j === undefined) continue;
    if (!j || typeof j !== "object" || Array.isArray(j)) out.push(`${label} must be an object`);
    else if ((j.api !== undefined && !["ollama", "openai"].includes(j.api)) || (j.url !== undefined && !/^https?:\/\//.test(String(j.url)))) out.push(`${label} needs api ollama or openai and an http(s) url`);
  }
  return out;
}
