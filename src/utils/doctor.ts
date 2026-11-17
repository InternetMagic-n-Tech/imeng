import { GATE_BLOCKS } from "./gate-blocks.js";
import path from "node:path";
import { iconNameProblem } from "./icon.js";
import type { GameConfig, GameState, JudgeInstanceConfig } from "./types.js";
import { checkImages } from "./doctor-images.js";
import { checkSeating } from "./doctor-seating.js";
import { checkTerms } from "./doctor-terms.js";
import { checkVision } from "./doctor-vision.js";
import { checkIdentity } from "./doctor-identity.js";
import { checkMigrations } from "./doctor-migrations.js";
import { checkRehydrate } from "./doctor-rehydrate.js";
import { goalProblems, imageExtrasProblems } from "./doctor-goals.js";
import { conditionProblems, evalCondition } from "./conditions.js";

/*
 * Environment doctor: checks that the hardware, the model server (Ollama, or any OpenAI-compatible
 * server such as llama.cpp), the game files and the proxy's own setup fit together.
 *
 * Everything that touches the machine goes through `Sys`, so the checks are testable and the same code
 * runs on Linux, macOS and Windows. Each check returns Findings; the runner collects them (and can stop
 * at the first problem with `bail`).
 */

export type Level = "ok" | "info" | "warn" | "fail";

export interface Finding {
  /** Stable id, usable with --ignore. */
  id: string;
  level: Level;
  title: string;
  detail?: string;
  fix?: string;
}

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
const gib = (n: number): string => (n / GiB).toFixed(1) + " GiB";

// ---------- the system interface (real implementation at the bottom) ----------
export interface HttpResult { ok: boolean; status: number; json?: any }

export interface Sys {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  totalmem(): number;
  freemem(): number;
  cpus(): { model: string }[];
  /** Run a command; null if it is missing, fails or times out. */
  exec(cmd: string, args: string[], timeoutMs?: number): Promise<string | null>;
  /** HTTP request; null if the connection fails. */
  http(url: string, init?: { method?: string; body?: unknown }, timeoutMs?: number): Promise<HttpResult | null>;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  /** True if nothing is listening on the port (tried on all interfaces). */
  portFree(port: number): Promise<boolean>;
  redisPing(url: string, timeoutMs?: number): Promise<{ ok: boolean; error?: string }>;
  /** The database's applied migrations and stamp (utils/db-migrations.ts), or the error. */
  dbState?(url: string): Promise<{ applied: string[]; appliedGame?: string[]; stamp: Record<string, string> } | { error: string }>;
}

// ---------- settings the checks need (built from the app's config by doctor.ts) ----------
export interface Settings {
  upstream: string;               // OpenAI-style base, e.g. http://localhost:11434/v1
  model: string;                  // narrator model
  judgeModel: string;
  judgeUrl: string;               // JUDGE_URL, or ""
  judgeApi?: "ollama" | "openai"; // judge_api
  judgeInstance: JudgeInstanceConfig | null;
  judgeNumCtx: number;
  gameDir: string;
  systemPrompt: string;
  /** System prompt + state block + dice block, as sent to the narrator on a typical turn. */
  fixedPromptText: string;
  game: GameConfig;
  invocation: "judge" | "always";
  dice: boolean;
  port: number;
  redisUrl: string;
  /** DATABASE_URL, or "" for none. */
  databaseUrl?: string;
  /** PII_SALT, for the pii_filter tokens. */
  piiSalt?: string;
  /** What this code expects of the database (default: the running code's own). */
  dbExpected?: import("./db-migrations.js").Expected;
  nodeEngines?: string;           // package.json engines.node
  promptFileFound: boolean;
  /** Recognises the trigger sentence at the top of the system prompt (config.json trigger_pattern, or the built-in). */
  triggerPattern?: RegExp;
}

export interface Hardware {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cores: number;
  ramTotal: number;
  ramFree: number;
  gpus: { name: string; vramTotal: number; vramUsed: number | null; kind: "nvidia" | "apple" }[];
  /** True when the GPU shares system memory (Apple Silicon). */
  unified: boolean;
}

// ---------- pure helpers ----------
/** Rough token count (about 4 characters per token for English prose). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function parseNvidiaSmi(csv: string): Hardware["gpus"] {
  const gpus: Hardware["gpus"] = [];
  for (const line of csv.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [name, total, used] = line.split(",").map((s) => s.trim());
    const t = Number(total);
    if (!name || !Number.isFinite(t)) continue;
    gpus.push({ name, vramTotal: t * MiB, vramUsed: Number.isFinite(Number(used)) ? Number(used) * MiB : null, kind: "nvidia" });
  }
  return gpus;
}

export async function detectHardware(sys: Sys): Promise<Hardware> {
  const cpus = sys.cpus();
  const hw: Hardware = {
    platform: sys.platform, arch: sys.arch, cpuModel: cpus[0]?.model?.trim() || "unknown CPU", cores: cpus.length,
    ramTotal: sys.totalmem(), ramFree: sys.freemem(), gpus: [], unified: false,
  };
  const smi = await sys.exec("nvidia-smi", ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"]);
  if (smi) hw.gpus = parseNvidiaSmi(smi);
  if (!hw.gpus.length && sys.platform === "darwin" && sys.arch === "arm64") {
    // Apple Silicon: the GPU shares system memory; macOS lets it use roughly three quarters by default.
    hw.unified = true;
    hw.gpus = [{ name: "Apple Silicon GPU (unified memory)", vramTotal: Math.round(hw.ramTotal * 0.75), vramUsed: null, kind: "apple" }];
  }
  return hw;
}

/** Per-layer KV-cache layout read from Ollama's /api/show `model_info`. */
export interface KvLayout {
  layers: { heads: number; keyLen: number; valueLen: number; sliding: boolean }[];
  slidingWindow: number | null;
  trainedContext: number | null;
}

export function kvLayout(modelInfo: Record<string, any> | undefined): KvLayout | null {
  if (!modelInfo) return null;
  const arch = modelInfo["general.architecture"];
  if (typeof arch !== "string") return null;
  const get = (k: string) => modelInfo[`${arch}.${k}`];
  const blocks = Number(get("block_count"));
  if (!Number.isFinite(blocks) || blocks <= 0) return null;

  const heads = get("attention.head_count");
  const kv = get("attention.head_count_kv") ?? heads;
  const emb = Number(get("embedding_length"));
  const baseHeads = Array.isArray(heads) ? Number(heads[0]) : Number(heads);
  const dflt = Number.isFinite(emb) && baseHeads ? emb / baseHeads : NaN;
  const kLen = Number(get("attention.key_length") ?? dflt);
  const vLen = Number(get("attention.value_length") ?? kLen);
  const kSwa = Number(get("attention.key_length_swa") ?? kLen);
  const vSwa = Number(get("attention.value_length_swa") ?? vLen);
  if (![kLen, vLen].every(Number.isFinite)) return null;

  const pattern = get("attention.sliding_window_pattern");
  const window = get("attention.sliding_window");
  const layers = Array.from({ length: blocks }, (_, i) => {
    const sliding = Array.isArray(pattern) ? Boolean(pattern[i]) : false;
    return {
      heads: Array.isArray(kv) ? Number(kv[i]) : Number(kv),
      keyLen: sliding && Number.isFinite(kSwa) ? kSwa : kLen,
      valueLen: sliding && Number.isFinite(vSwa) ? vSwa : vLen,
      sliding,
    };
  });
  if (layers.some((l) => !Number.isFinite(l.heads))) return null;
  const ctx = get("context_length");
  return { layers, slidingWindow: typeof window === "number" ? window : null, trainedContext: typeof ctx === "number" ? ctx : null };
}

/**
 * KV cache size in bytes for `ctx` tokens (f16 K and V).
 * `swaAware: false` gives the full-attention upper bound, which is what many llama.cpp builds actually
 * allocate even for sliding-window models; `true` counts sliding layers at their window size only.
 */
export function kvBytes(layout: KvLayout, ctx: number, swaAware = false): number {
  return layout.layers.reduce((sum, l) => {
    const tokens = swaAware && l.sliding && layout.slidingWindow ? Math.min(ctx, layout.slidingWindow) : ctx;
    return sum + l.heads * (l.keyLen + l.valueLen) * 2 * tokens;
  }, 0);
}

/**
 * Largest context (multiple of 1024) whose weights + KV + overhead fit in `vram`; 0 if even 1024 does not.
 * `layout.trainedContext` (or 262144) caps the search.
 */
export function maxContextThatFits(vram: number, weights: number, layout: KvLayout, overhead: number, parallel = 1, swaAware = false): number {
  const fits = (ctx: number) => weights + kvBytes(layout, ctx, swaAware) * parallel + overhead <= vram;
  if (!fits(1024)) return 0;
  let lo = 1024;
  let hi = Math.max(1024, Math.floor((layout.trainedContext ?? 262144) / 1024) * 1024);
  if (fits(hi)) return hi;
  while (hi - lo > 1024) {
    const mid = Math.floor((lo + hi) / 2 / 1024) * 1024;
    if (mid <= lo) break;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** GPU memory to leave for the compute graph, the CUDA runtime and driver reservations (a conservative margin). */
export const overheadFor = (vram: number): number => Math.max(1.5 * GiB, Math.round(vram * 0.08));

/** Context the game needs: what is sent every turn, plus room for state growth and conversation. */
export const GROWTH_TOKENS = 1500;       // state grows as the game goes on
export const REPLY_TOKENS = 800;         // the narrator's answer
export const TOKENS_PER_EXCHANGE = 350;  // one player message + one narration (~150-200 words)
export function contextNeeds(fixedTokens: number) {
  const base = fixedTokens + GROWTH_TOKENS + REPLY_TOKENS;
  return { minimum: base + 4 * TOKENS_PER_EXCHANGE * 3, comfortable: base + 40 * TOKENS_PER_EXCHANGE, base };
}

/** The `ollama serve` command with the given settings, in the platform's shell syntax. */
export function serveCommand(platform: NodeJS.Platform, env: Record<string, string>): string {
  const pairs = Object.entries(env);
  if (platform === "win32") return pairs.map(([k, v]) => `$env:${k}="${v}"`).join("; ") + "; ollama serve";
  return pairs.map(([k, v]) => `${k}=${/[^\w.:/-]/.test(v) ? `"${v}"` : v}`).join(" ") + " ollama serve";
}

/** Does `version` satisfy a simple ">=a.b.c <d" engines range? Unknown shapes pass. */
export function satisfiesEngines(version: string, range: string | undefined): boolean {
  if (!range) return true;
  const v = version.replace(/^v/, "").split(".").map(Number);
  const ge = /(?:>=)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  const lt = /<\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
  if (ge && cmp(v, ge.slice(1).map(Number)) < 0) return false;
  if (lt && cmp(v, lt.slice(1).map(Number)) >= 0) return false;
  return true;
}

// ---------- shared context ----------
interface Ctx {
  sys: Sys;
  s: Settings;
  hw: Hardware;
  /** Filled in as checks run so later checks can reuse it. */
  shared: {
    backend?: "ollama" | "openai" | "none";
    base?: string;
    tags?: { name: string; size: number }[];
    ps?: { name: string; size: number; size_vram: number; context_length?: number }[];
    serveEnv?: Record<string, string> | null;
    narratorInfo?: Record<string, any>;
    effectiveCtx?: number | null;
    recommendedCtx?: number | null;
  };
}

const ok = (id: string, title: string, detail?: string): Finding => ({ id, level: "ok", title, detail });
const info = (id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level: "info", title, detail, fix });
/** JSON examples in a prompt that still hold placeholders ("...", "<value>", "string", "blah"): small models copy them literally, so write a real example. */
export function placeholderJson(text: string): string[] {
  const found = new Set<string>();
  for (const region of text.match(/```[\s\S]*?```|\{[^{}]*"[\w-]+"\s*:[^{}]*\}/g) ?? []) {
    if (!/"[\w-]+"\s*:/.test(region)) continue;
    for (const m of region.matchAll(/:\s*(?:"(?:\.\.\.|<[^">\n]+>|string|number|boolean|value|text|blah[\w-]*|foo|bar|xxx+|todo)"|\.\.\.|<[^>\n]+>)(?=\s*[,}\]\n])/gi)) found.add(m[0].replace(/^:\s*/, ""));
    for (const m of region.matchAll(/[\[,]\s*(\.\.\.|"\.\.\.")\s*(?=[,\]])/g)) found.add(m[1]!);
  }
  return [...found];
}

const warn = (id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level: "warn", title, detail, fix });
const fail = (id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level: "fail", title, detail, fix });

const baseOf = (upstream: string): string => upstream.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ""; } };
const sameModel = (name: string, wanted: string): boolean => name === wanted || name === `${wanted}:latest` || wanted === `${name}:latest`;

// ---------- 1. runtime ----------
async function checkRuntime({ sys, s }: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  if (satisfiesEngines(sys.nodeVersion, s.nodeEngines)) out.push(ok("node-version", `Node ${sys.nodeVersion}`, s.nodeEngines ? `satisfies engines "${s.nodeEngines}"` : undefined));
  else out.push(fail("node-version", `Node ${sys.nodeVersion} is outside the supported range "${s.nodeEngines}"`, undefined, "Use the supported LTS line (the Docker image already does)."));
  return out;
}

// ---------- 2. hardware ----------
async function checkHardware({ hw }: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  out.push(info("hw-cpu", `${hw.cpuModel}, ${hw.cores} threads, ${hw.platform}/${hw.arch}`));
  out.push(hw.ramTotal >= 16 * GiB
    ? ok("hw-ram", `RAM ${gib(hw.ramTotal)} (${gib(hw.ramFree)} free)`)
    : warn("hw-ram", `RAM ${gib(hw.ramTotal)} (${gib(hw.ramFree)} free) is small for local models`, undefined, "Use smaller or more heavily quantized models."));
  if (hw.gpus.length) {
    for (const g of hw.gpus) {
      out.push(ok("hw-gpu", `GPU ${g.name}: ${gib(g.vramTotal)}${g.vramUsed != null ? `, ${gib(g.vramUsed)} in use` : ""}${hw.unified ? " (shared with system memory; approximate)" : ""}`));
    }
  } else {
    out.push(info("hw-gpu", "No supported GPU detected (NVIDIA via nvidia-smi, or Apple Silicon)", "Fit estimates against VRAM are skipped; models will run on the CPU unless Ollama finds another GPU (AMD/Intel).", "Check `ollama ps` while a model is loaded: the PROCESSOR column shows the CPU/GPU split."));
  }
  return out;
}

// ---------- 3. game files, prompt and config ----------
async function checkGame({ s, sys }: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  out.push(s.promptFileFound
    ? ok("game-files", `Game "${s.gameDir}": SYSTEM_PROMPT.md found`)
    : warn("game-files", `No SYSTEM_PROMPT.md in ${s.gameDir}`, "The built-in generic narrator prompt will be used.", "Create SYSTEM_PROMPT.md in the game directory."));

  const cfg = s.game;
  const problems: string[] = [];
  const ids = (cfg.session_rules || []).map((r) => r.id);
  if (new Set(ids).size !== ids.length) problems.push("session_rules has duplicate ids");
  if ((cfg.session_rules || []).some((r) => !r.id || !r.text)) problems.push("a session rule is missing its id or text");
  if (cfg.setup_turns !== undefined && !(cfg.setup_turns >= 0)) problems.push("setup_turns must be 0 or more");
  for (const r of cfg.exit_group_when || []) problems.push(...conditionProblems(r, false).map((p) => `an exit_group_when rule: ${p}`));
  if (cfg.unique_fields !== undefined && (!Array.isArray(cfg.unique_fields) || cfg.unique_fields.some((f) => typeof f !== "string" || !f))) problems.push("unique_fields must be a list of field names");
  if (cfg.allowed_values !== undefined && (typeof cfg.allowed_values !== "object" || cfg.allowed_values === null || Object.values(cfg.allowed_values).some((v) => !Array.isArray(v) || !v.length))) problems.push("allowed_values must map a field to a non-empty list of values");
  if (cfg.sticky_fields !== undefined && (typeof cfg.sticky_fields !== "object" || cfg.sticky_fields === null || Object.values(cfg.sticky_fields).some((n) => !Number.isInteger(n) || n < 1))) problems.push("sticky_fields must map a path to a whole number of turns, 1 or more");
  const ops = ["gt", "gte", "lt", "lte", "eq"] as const;
  if (cfg.decrease_locks !== undefined && (!Array.isArray(cfg.decrease_locks) || cfg.decrease_locks.some((l) => !l?.field || (l.while !== undefined && (!l.while.field || !ops.some((o) => typeof l.while![o] === "number")))))) problems.push("a decrease_locks rule needs a field, and a `while` (if given) needs a field and gt, gte, lt, lte or eq");
  // a group rule that is already true for a fresh cast would end the game before it starts
  const cast = [...Object.entries(cfg.initial_state?.actors || {}), ["_npc", {}]].map(([id, a]) => [id, { ...(cfg.actor_template || {}), ...(a as object) }] as [string, Record<string, unknown>]);
  const fresh = { game: { turn: 0, current_actor: null, exited_game: [], events: [], rules: {}, ...(cfg.initial_state?.game || {}) }, actors: Object.fromEntries(cast) } as unknown as GameState;
  for (const r of cfg.exit_group_when || []) {
    if (conditionProblems(r, false).length) continue;
    if (evalCondition(r, fresh)) problems.push(`the exit_group_when rule${"field" in r ? ` on "${r.field}"` : ""} is already true at the start, so the game would end at once`);
  }
  for (const r of cfg.exit_when || []) problems.push(...conditionProblems(r, true).map((p) => `an exit_when rule: ${p}`));
  const wu = cfg.wrap_up;
  if (wu) {
    if (!(Number(wu.at_tokens) > 0) && !(Number(wu.at_turn) > 0)) problems.push("wrap_up needs at_tokens or at_turn above 0");
    for (const k of ["at_turn", "soon_turns"] as const) if (wu[k] !== undefined && !(Number.isInteger(wu[k]) && (wu[k] as number) >= 0)) problems.push(`wrap_up.${k} must be a whole number, 0 or more`);
    if (Number(wu.soon_turns) > 0 && !(Number(wu.at_turn) > Number(wu.soon_turns))) problems.push("wrap_up.soon_turns needs an at_turn above it");
    if (wu.credits_file !== undefined) {
      const rel = String(wu.credits_file), root = path.resolve(s.gameDir), file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) problems.push("wrap_up.credits_file must be a file inside the game folder");
      else if (sys.readFile(file) === null) problems.push(`wrap_up.credits_file ${rel} was not found`);
      else if (!sys.readFile(file)!.trim()) problems.push(`wrap_up.credits_file ${rel} is empty`);
    }
  }
  for (const [field, tpl] of Object.entries((cfg as { field_evidence?: Record<string, string> }).field_evidence ?? {})) {
    try { new RegExp(tpl.replace(/\{name\}/g, "(?:x)"), "i"); } catch { problems.push(`field_evidence.${field} is not a valid regular expression`); }
  }
  const stockOpts = (cfg as { tools?: Record<string, Record<string, unknown>> }).tools?.stock;
  if (stockOpts && typeof stockOpts.calendar_file === "string") {
    const root = path.resolve(s.gameDir), file = path.resolve(root, stockOpts.calendar_file), text = file.startsWith(root + path.sep) ? sys.readFile(file) : null;
    if (text === null) problems.push(`tools.stock.calendar_file ${stockOpts.calendar_file} was not found in the game folder`);
    else { try { JSON.parse(text); } catch { problems.push(`tools.stock.calendar_file ${stockOpts.calendar_file} is not valid JSON`); } }
  }
  if (cfg.judge_confirmations !== undefined && !(cfg.judge_confirmations >= 1)) problems.push("judge_confirmations must be 1 or more");
  if (cfg.dice && typeof cfg.dice === "object" && Object.entries(cfg.dice).some(([die, n]) => !/^d\d+$/i.test(die) || !Number.isInteger(n) || n < 1 || n > 100)) problems.push('dice must be true or an object like {"d20": 4} (die names such as d6, counts from 1 to 100)');
  for (const key of ["user_id", "npc_prefix"] as const) {
    if (cfg[key] !== undefined && (typeof cfg[key] !== "string" || !cfg[key])) problems.push(`${key} must be a non-empty string`);
  }
  if (cfg.writable_fields !== undefined && (!Array.isArray(cfg.writable_fields) || cfg.writable_fields.some((f) => typeof f !== "string"))) problems.push("writable_fields must be a list of field names");
  if (Object.values(cfg.limits || {}).some((l) => l.max_step !== undefined && !(l.max_step > 0))) problems.push("a limits max_step must be greater than 0");
  if (cfg.world?.era === "custom" && !cfg.world.canon?.file) problems.push("world.era is custom: give world.canon.file (the reference for the setting)");
  if (cfg.world?.languages?.list?.length) { const f = cfg.world.languages.field || "languages"; if (!(cfg.writable_fields ?? []).includes(f)) problems.push(`world.languages: add "${f}" to writable_fields (and actor_template) so the state can say who understands which tongue`); }
  if (cfg.world && (cfg.world.anachronism ?? "block") === "block" && cfg.enforce_rules !== true) problems.push("world.anachronism is block, which is a locked session rule the audit judge enforces: set enforce_rules to true (or use warn or allow)");
  if (cfg.prompts && Object.values(cfg.prompts).some((v) => typeof v !== "string")) problems.push("prompts values must be text");
  if (cfg.knowledge?.enabled && !cfg.judge_model && !process.env.JUDGE_MODEL) out.push(warn("knowledge-judge", "knowledge is on but no judge_model is set", "The judge that reads secrets and triggers falls back to the narrator model, which is slow and heavy for a classifier.", "Set judge_model (a small local model) in config.json or JUDGE_MODEL."));
  if (cfg.crossings) {
    const x: any = cfg.crossings, ph: any = cfg.phases ?? {};
    const nx = (k: string): string[] => [].concat(ph[k]?.next ?? []);
    if (!ph[x.phase] || !ph[x.back]) problems.push("crossings.phase and crossings.back must both be phases in `phases`");
    else if (!nx(x.back).includes(x.phase)) problems.push(`crossings: the phase ${x.back} must list ${x.phase} in its next`);
    if (x.places && x.places.length !== 2) problems.push("crossings.places needs exactly two places");
  }
  const gtc = cfg.game_turn;
  if (cfg.turn_events?.length && !gtc) problems.push("turn_events needs game_turn");
  if (gtc?.advance === "field" && !/^game\.\w+$/.test(String(gtc.field ?? ""))) problems.push('game_turn.advance "field" needs field set to "game.<name>"');
  if (gtc?.advance === "judged" && !String(gtc.rule ?? "").trim()) problems.push('game_turn.advance "judged" needs a rule in words');
  for (const [i, e] of (cfg.turn_events || []).entries()) {
    const n = `turn_events[${i}]${e.id ? ` (${e.id})` : ""}`;
    if (!(Number(e.at) >= 1) && !(Number(e.every) >= 1)) problems.push(`${n} needs at or every (1 or more)`);
    if (e.at && e.every) problems.push(`${n} has both at and every`);
    if (e.if !== undefined) problems.push(...conditionProblems(e.if, false).map((p) => `${n}: ${p}`));
    if (e.end && !e.text) problems.push(`${n} ends the game and needs text (the closing instructions)`);
    for (const k of Object.keys(e.set ?? {})) if (!/^game\.\w+$/.test(k)) problems.push(`${n}: set paths must be game.<field> (${k})`);
  }
  problems.push(...calcPhaseProblems(cfg), ...goalProblems(cfg), ...imageExtrasProblems(cfg));
  const maxTok = Math.floor(Number(process.env.CONTEXT_MAX_TOKENS)) || 0;
  if (maxTok > 0) {
    const low = [["compaction.at_tokens", cfg.compaction?.at_tokens], ["wrap_up.at_tokens", cfg.wrap_up?.at_tokens]].filter(([, v]) => Number(v) >= maxTok).map(([k]) => k);
    if (low.length) problems.push(`env CONTEXT_MAX_TOKENS (${maxTok}) must be above ${low.join(" and ")}, or compaction and the wrap-up never get to act`);
  }
  if (cfg.icon !== undefined) {
    const why = iconNameProblem(String(cfg.icon));
    if (why) problems.push(`icon ${why}`);
    else if (!sys.exists(path.resolve(s.gameDir, String(cfg.icon)))) problems.push(`icon ${cfg.icon} was not found in the game folder`);
  }
  if (cfg.history_limit !== undefined && cfg.actor_history_limit === undefined) out.push(warn("game-history-limit", "history_limit is the old name (v1.1)", "It still works.", "Rename it to actor_history_limit."));
  out.push(problems.length ? fail("game-config", "config.json has problems", problems.join("; "), "Fix config.json.") : ok("game-config", "config.json looks sane"));

  // The system prompt, dice and invocation settings should agree with each other.
  const mentionsDice = /\bdice\b|\bd\d+\b/i.test(s.systemPrompt);
  if (s.dice && !/dice/i.test(s.systemPrompt)) out.push(warn("prompt-dice", 'config.json has "dice": true but the system prompt never mentions dice', "The narrator receives a pre-rolled dice block but isn't told how to use it.", "Mention the DICE block in SYSTEM_PROMPT.md, or set dice to false."));
  else if (!s.dice && /pre-?rolled|DICE block|dice provided/i.test(s.systemPrompt)) out.push(warn("prompt-dice", 'The system prompt expects pre-rolled dice but config.json has no "dice": true', "The narrator will be told to use dice that are never provided, so it will invent rolls.", 'Set "dice": true in config.json.'));
  else out.push(ok("prompt-dice", s.dice ? "Dice are enabled and the prompt mentions them" : mentionsDice ? "Dice are off; the prompt mentions dice generally" : "Dice are off"));

  const head = s.systemPrompt.slice(0, 1500);
  const hasTrigger = (s.triggerPattern ?? /\b(?:if|when|whenever)\b[^.\n]{0,120}\bmessage\b/i).test(head);
  if (s.invocation === "always" && hasTrigger) out.push(warn("invocation", 'The prompt opens with a trigger condition but config.json has "invocation": "always"', "The trigger is ignored: every chat becomes a game.", 'Remove "invocation": "always" so the first message is checked.'));
  else if (hasTrigger) out.push(ok("invocation", "The prompt has a trigger condition, so first messages decide game vs plain chat"));
  else out.push(info("invocation", "No trigger condition in the prompt: every chat is a game", undefined, 'Start the prompt with e.g. If the user\'s first message is "Imeng: X" follow these instructions.'));
  const prompts: [string, string][] = [["SYSTEM_PROMPT.md", s.systemPrompt], ...Object.entries(s.game.prompts ?? {}).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => [`prompts.${k}`, v] as [string, string])];
  const bad = prompts.flatMap(([n, t]) => placeholderJson(t).map((p) => `${n}: ${p}`));
  out.push(bad.length
    ? warn("prompt-json", "A prompt has JSON examples with placeholders in them", bad.slice(0, 6).join("; "), 'Write a real, working example (real keys and plausible values). Small models copy placeholders such as "..." or "<value>" literally.')
    : ok("prompt-json", "No placeholder JSON in the prompts"));
  return out;
}

// ---------- 4. the model server ----------
async function checkBackend(c: Ctx): Promise<Finding[]> {
  const { sys, s, hw, shared } = c;
  const out: Finding[] = [];
  const base = baseOf(s.upstream);
  shared.base = base;

  const inContainer = sys.exists("/.dockerenv");
  if (inContainer && ["localhost", "127.0.0.1", "::1"].includes(hostOf(s.upstream))) {
    out.push(fail("upstream-container", `UPSTREAM is ${s.upstream} but this is inside a container`, "localhost in a container is the container itself, not your machine.", "Use http://host.docker.internal:11434/v1 (PROXY_UPSTREAM in compose)."));
  }

  const version = await sys.http(`${base}/api/version`);
  if (version?.ok) {
    shared.backend = "ollama";
    out.push(ok("backend", `Ollama ${version.json?.version ?? ""} is running at ${base}`));
  } else {
    const models = await sys.http(`${s.upstream}/models`);
    if (models?.ok) {
      shared.backend = "openai";
      const ids: string[] = (models.json?.data || []).map((m: any) => m.id);
      out.push(info("backend", `An OpenAI-compatible server (llama.cpp, LM Studio, vLLM...) is answering at ${s.upstream}`, `Models: ${ids.join(", ") || "none listed"}. Ollama-specific checks are skipped.`));
      out.push(ids.some((id) => sameModel(id, s.model))
        ? ok("model-installed", `Model "${s.model}" is served`)
        : warn("model-installed", `Model "${s.model}" is not in the server's model list`, `Served: ${ids.join(", ") || "none"}`, "Set OLLAMA_MODEL to a served model id."));
      const props = await sys.http(`${base}/props`);
      const n = props?.json?.default_generation_settings?.n_ctx;
      if (typeof n === "number") {
        const needs = contextNeeds(estimateTokens(s.fixedPromptText));
        out.push(n >= needs.minimum
          ? ok("ctx-needed", `llama.cpp context is ${n} tokens (the game needs at least ~${needs.minimum})`)
          : fail("ctx-needed", `llama.cpp context is only ${n} tokens; the game needs at least ~${needs.minimum}`, undefined, "Start llama-server with a larger -c value."));
      }
    } else {
      shared.backend = "none";
      const bin = await sys.exec(sys.platform === "win32" ? "where" : "which", ["ollama"]);
      out.push(fail("backend", `Nothing answers at ${base} (no Ollama, no OpenAI-compatible server)`,
        bin ? `The ollama binary is installed (${bin.split("\n")[0].trim()}), it just isn't running.` : "The ollama binary was not found on PATH either.",
        bin ? `Start it, e.g.: ${serveCommand(sys.platform, { OLLAMA_HOST: "127.0.0.1:11434" })}` : "Install Ollama (https://ollama.com) or point UPSTREAM at another OpenAI-compatible server."));
    }
  }

  const dockerPs = await sys.exec("docker", ["ps", "--format", "{{.Image}} {{.Names}}"], 4000);
  if (dockerPs && /ollama/i.test(dockerPs)) {
    out.push(warn("ollama-in-docker", "An Ollama container is running", "Ollama in Docker usually performs worse than on the host (GPU passthrough, memory limits).", "Run Ollama on the host and keep only the proxy in Docker."));
  }
  void hw;
  return out;
}

async function checkOllama(c: Ctx): Promise<Finding[]> {
  const { sys, s, hw, shared } = c;
  if (shared.backend !== "ollama") return [];
  const out: Finding[] = [];
  const base = shared.base!;

  const tags = await sys.http(`${base}/api/tags`);
  shared.tags = (tags?.json?.models || []).map((m: any) => ({ name: m.name, size: m.size }));
  const ps = await sys.http(`${base}/api/ps`);
  shared.ps = ps?.json?.models || [];

  const narrator = shared.tags!.find((m) => sameModel(m.name, s.model));
  if (!narrator) {
    out.push(fail("model-installed", `Narrator model "${s.model}" is not installed`, `Installed: ${shared.tags!.map((m) => m.name).slice(0, 8).join(", ") || "none"}`, `ollama pull ${s.model}   (or set OLLAMA_MODEL)`));
    return out;
  }
  out.push(ok("model-installed", `Narrator model "${s.model}" is installed (${gib(narrator.size)} of weights)`));

  // The server's own settings (readable on Linux), else what the API reveals.
  const serveEnv = await ollamaServeEnv(sys);
  shared.serveEnv = serveEnv;
  const loaded = shared.ps!.find((m) => sameModel(m.name, s.model));
  const envCtx = serveEnv?.OLLAMA_CONTEXT_LENGTH ? Number(serveEnv.OLLAMA_CONTEXT_LENGTH) : null;
  const effectiveCtx = envCtx ?? loaded?.context_length ?? null;
  shared.effectiveCtx = effectiveCtx;
  out.push(serveEnv
    ? info("ollama-env", "Ollama server settings", Object.entries(serveEnv).map(([k, v]) => `${k}=${v}`).join("  ") || "(no OLLAMA_* variables set; defaults apply)")
    : info("ollama-env", "Could not read the Ollama server's environment", sys.platform === "linux" ? "No running `ollama serve` process readable by this user." : "Only readable on Linux; using what the API reports.", undefined));

  if (serveEnv?.OLLAMA_HOST && /^(0\.0\.0\.0|\[?::\]?)(:|$)/.test(serveEnv.OLLAMA_HOST)) {
    out.push(warn("ollama-exposed", `OLLAMA_HOST=${serveEnv.OLLAMA_HOST} listens on every network interface`, "Ollama has no authentication, so anyone who can reach this machine can use your models.", "Bind 127.0.0.1 (and the Docker bridge address, if containers need it), or firewall port 11434."));
  }
  const keep = serveEnv?.OLLAMA_KEEP_ALIVE;
  if (keep && /^0[smh]?$/.test(keep)) out.push(warn("ollama-keepalive", `OLLAMA_KEEP_ALIVE=${keep} unloads the model after every request`, "Each turn would reload the narrator.", "Use something like 15m."));
  else if (keep) out.push(ok("ollama-keepalive", `OLLAMA_KEEP_ALIVE=${keep}`));
  const modelsDir = serveEnv?.OLLAMA_MODELS;
  if (modelsDir && !sys.exists(modelsDir)) out.push(warn("ollama-models", `OLLAMA_MODELS=${modelsDir} does not exist from this account`, undefined, "Check the path and permissions."));

  // ---- context: what the game needs, what the model supports, what fits ----
  const fixed = estimateTokens(s.fixedPromptText);
  const needs = contextNeeds(fixed);
  out.push(info("prompt-size", `System prompt + state + dice ≈ ${fixed} tokens per turn`, `Game needs at least ~${needs.minimum} tokens of context (~${needs.comfortable} to be comfortable): the prompt, state growth (~${GROWTH_TOKENS}), a reply (~${REPLY_TOKENS}) and the conversation (~${TOKENS_PER_EXCHANGE} per exchange).`));

  const show = await sys.http(`${base}/api/show`, { method: "POST", body: { model: s.model } });
  shared.narratorInfo = show?.json?.model_info;
  const layout = kvLayout(shared.narratorInfo);

  if (effectiveCtx == null) {
    out.push(info("ctx-needed", "Context length not known yet", "It isn't set via OLLAMA_CONTEXT_LENGTH that this check can see, and the model isn't loaded.", "Load the model once (send a chat) and re-run, or set OLLAMA_CONTEXT_LENGTH."));
  } else {
    if (effectiveCtx < needs.minimum) out.push(fail("ctx-needed", `Context ${effectiveCtx} is too small for this game (needs ≥ ~${needs.minimum})`, "The system prompt and state would crowd out the conversation, and Ollama silently truncates what doesn't fit.", `Set OLLAMA_CONTEXT_LENGTH to at least ${Math.ceil(needs.comfortable / 1024) * 1024} if it fits (see below).`));
    else {
      const turns = Math.max(0, Math.floor((effectiveCtx - needs.base) / TOKENS_PER_EXCHANGE));
      out.push(ok("ctx-needed", `Context ${effectiveCtx}: room for about ${turns} exchanges before the oldest history is truncated`));
    }
    if (layout?.trainedContext && effectiveCtx > layout.trainedContext) out.push(warn("ctx-trained", `Context ${effectiveCtx} exceeds what the model was trained for (${layout.trainedContext})`, undefined, "Lower OLLAMA_CONTEXT_LENGTH."));
  }

  // ---- fit in VRAM ----
  const gpu = hw.gpus[0];
  const parallel = serveEnv?.OLLAMA_NUM_PARALLEL ? Math.max(1, Number(serveEnv.OLLAMA_NUM_PARALLEL) || 1) : 1;
  if (gpu && layout && effectiveCtx != null) {
    const overhead = overheadFor(gpu.vramTotal);
    const swa = layout.slidingWindow != null && layout.layers.some((l) => l.sliding);
    const kvUpper = kvBytes(layout, effectiveCtx) * parallel;                       // every layer caches the full context
    const kvLikely = swa ? kvBytes(layout, effectiveCtx, true) * parallel : kvUpper; // sliding layers cache only their window
    const needLikely = narrator.size + kvLikely + overhead;
    const needUpper = narrator.size + kvUpper + overhead;
    const detail = `weights ${gib(narrator.size)} + KV cache ${gib(kvLikely)}${swa ? ` (${gib(kvUpper)} if the runner caches the full context on every layer)` : ""} at ${effectiveCtx} tokens${parallel > 1 ? ` x${parallel} parallel` : ""} + ~${gib(overhead)} overhead = ${gib(needLikely)}${swa ? ` (up to ${gib(needUpper)})` : ""}, against ${gib(gpu.vramTotal)} of VRAM.`;
    if (needUpper <= gpu.vramTotal) {
      out.push(ok("ctx-fit", `Model + ${effectiveCtx}-token context should fit in VRAM`, detail));
    } else if (needLikely <= gpu.vramTotal) {
      out.push(info("ctx-fit", `Model + ${effectiveCtx}-token context should fit in VRAM with sliding-window KV caching`, `${detail} It only fits if the runner exploits that, so check with --probe, or look at the PROCESSOR column of \`ollama ps\`.`));
    } else {
      const fit = maxContextThatFits(gpu.vramTotal, narrator.size, layout, overhead, parallel, swa);
      shared.recommendedCtx = fit >= needs.minimum ? fit : null;
      out.push(fit >= needs.minimum
        ? warn("ctx-fit", `Model + ${effectiveCtx}-token context do not fit in VRAM; part of the model will run on the CPU`, detail, `A context up to ~${fit} tokens should fit entirely on the GPU (the game needs ≥ ~${needs.minimum}). Trade-off: a longer context lets conversations run longer before truncation, but CPU offload makes every turn slower. Verify with --probe.`)
        : fail("ctx-fit", `Model + context cannot fit this GPU even at the minimum the game needs (${needs.minimum})`, detail, "Use a smaller or more heavily quantized narrator model."));
    }
  } else if (!gpu) {
    out.push(info("ctx-fit", "VRAM fit not estimated (no supported GPU detected)"));
  } else if (!layout) {
    out.push(info("ctx-fit", "VRAM fit not estimated (the model's layout isn't available from /api/show)"));
  }

  // ---- observed: what is actually loaded right now ----
  if (loaded) {
    const onCpu = Math.max(0, loaded.size - loaded.size_vram);
    const pct = loaded.size ? Math.round((onCpu / loaded.size) * 100) : 0;
    if (pct >= 2) {
      // Would a smaller context help? Only if the overflow is smaller than the KV cache we could shrink.
      let advice = "Free VRAM (other loaded models, a GPU-resident judge, other GPU programs) or use a smaller model.";
      let note = "";
      if (layout && effectiveCtx) {
        const swa = layout.slidingWindow != null && layout.layers.some((l) => l.sliding);
        const kv = kvBytes(layout, effectiveCtx, swa) * parallel;
        if (onCpu < kv) {
          const newCtx = Math.floor((effectiveCtx * (kv - onCpu)) / kv / 1024) * 1024;
          if (newCtx >= needs.minimum) {
            note = ` Reducing the context to roughly ${newCtx} should bring it fully onto the GPU.`;
            advice = "Lower OLLAMA_CONTEXT_LENGTH, or free VRAM (other loaded models, other GPU programs).";
          }
        } else {
          note = ` The overflow is larger than the whole KV cache (~${gib(kv)}), so a smaller context alone will not fix it.`;
        }
      }
      out.push(warn("ctx-offload", `${s.model} is loaded with ${pct}% of the model on the CPU (${gib(onCpu)})`, `Ollama reports ${gib(loaded.size_vram)} of ${gib(loaded.size)} in VRAM at context ${loaded.context_length ?? effectiveCtx ?? "?"}.${note}`, advice));
    } else out.push(ok("ctx-offload", `${s.model} is loaded fully on the GPU`));
  } else {
    out.push(info("ctx-offload", `${s.model} is not loaded right now`, "Whether it fits is estimated above; run a chat and re-check, or use --probe."));
  }
  return out;
}

/** On Linux, read the OLLAMA_* environment of the running `ollama serve` (only works for your own processes). */
export async function ollamaServeEnv(sys: Sys): Promise<Record<string, string> | null> {
  if (sys.platform !== "linux") return null;
  const pids = (await sys.exec("pgrep", ["-x", "ollama"]))?.split("\n").map((p) => p.trim()).filter(Boolean) || [];
  for (const pid of pids) {
    const cmd = sys.readFile(`/proc/${pid}/cmdline`);
    if (cmd && !cmd.includes("serve")) continue;
    const raw = sys.readFile(`/proc/${pid}/environ`);
    if (!raw) continue;
    const env: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      const i = entry.indexOf("=");
      if (i > 0 && entry.startsWith("OLLAMA_")) env[entry.slice(0, i)] = entry.slice(i + 1);
    }
    return env;
  }
  return null;
}

// ---------- 5. the judge ----------
async function checkJudge(c: Ctx): Promise<Finding[]> {
  const { sys, s, hw, shared } = c;
  const out: Finding[] = [];
  const inst = s.judgeInstance;
  const judgeBase = s.judgeUrl || (inst ? `http://${inst.host || "127.0.0.1"}:${inst.port || 11435}` : shared.base || baseOf(s.upstream));
  const sharesNarrator = !s.judgeUrl && !inst;

  if (s.judgeApi === "openai") {
    const base = (s.judgeUrl || s.upstream).replace(/\/v1$/, "");
    out.push(info("judge-target", `The judge model "${s.judgeModel}" is called as an OpenAI-compatible server at ${base} (judge_api openai)`));
    const up = await sys.http(`${base}/v1/models`);
    out.push(up?.ok ? ok("judge-reachable", `The judge server answers at ${base}`) : fail("judge-reachable", `Nothing answers at ${base}/v1/models`, undefined, "Start the server (for llama.cpp: llama-server -m model.gguf --port 8081) and set JUDGE_URL."));
    return out;
  }

  out.push(info("judge-target", sharesNarrator
    ? `The judge model "${s.judgeModel}" shares the narrator's server`
    : s.judgeUrl ? `The judge model "${s.judgeModel}" is expected at ${judgeBase} (JUDGE_URL)`
    : `The judge model "${s.judgeModel}" runs in its own Ollama at ${judgeBase} (${inst!.gpu === false ? "CPU" : "GPU"})`));

  if (s.judgeNumCtx < 4096) out.push(warn("judge-ctx", `Judge context ${s.judgeNumCtx} is small`, "Judge prompts include the story so far.", "Use at least 4096 (judge_instance.num_ctx)."));

  const reach = sharesNarrator ? (shared.backend === "ollama" ? { ok: true, status: 200, json: { version: "" } } : null) : await sys.http(`${judgeBase}/api/version`);
  if (reach?.ok) out.push(ok("judge-reachable", `The judge's Ollama answers at ${judgeBase}`));
  else if (shared.backend === "openai" && sharesNarrator) {
    out.push(fail("judge-reachable", "The judge needs Ollama's native API, but only an OpenAI-compatible server is available", "Judge calls use /api/chat with per-request context and stop settings.", "Run a (small) Ollama for the judge and set JUDGE_URL, or add a judge_instance to config.json."));
  } else if (s.judgeUrl) {
    out.push(fail("judge-reachable", `Nothing answers at JUDGE_URL (${judgeBase})`, undefined, "Start the host judge with `npm run judge`."));
  } else if (inst) {
    const bin = await sys.exec(sys.platform === "win32" ? "where" : "which", ["ollama"]);
    const free = await sys.portFree(inst.port || 11435);
    if (bin && free) out.push(ok("judge-reachable", `The judge's Ollama isn't running yet, but the proxy can start it (ollama is installed, port ${inst.port || 11435} is free)`));
    else out.push(fail("judge-reachable", "The proxy can't start the judge's Ollama", !bin ? "The ollama binary was not found on PATH." : `Port ${inst.port || 11435} is taken by something that isn't an Ollama.`, !bin ? "Install Ollama." : "Free the port or change judge_instance.port."));
    if (inst.models_dir && !sys.exists(inst.models_dir)) out.push(warn("judge-models-dir", `judge_instance.models_dir ${inst.models_dir} does not exist on this machine`, undefined, "Point it at your Ollama models directory (it is machine-specific)."));
  }

  // installed? Ask the judge's own server if it's up, else the narrator's (shared models directory).
  let tags = shared.tags;
  if (!sharesNarrator && reach?.ok) tags = ((await sys.http(`${judgeBase}/api/tags`))?.json?.models || []).map((m: any) => ({ name: m.name, size: m.size }));
  const judge = tags?.find((m) => sameModel(m.name, s.judgeModel));
  if (tags) {
    out.push(judge ? ok("judge-installed", `Judge model "${s.judgeModel}" is installed (${gib(judge.size)})`) : fail("judge-installed", `Judge model "${s.judgeModel}" is not installed`, undefined, `ollama pull ${s.judgeModel}   (or set JUDGE_MODEL)`));
  }

  if (judge && !sharesNarrator) {
    const onGpu = inst ? inst.gpu !== false : false;
    if (onGpu && hw.gpus[0]) {
      const narrator = shared.tags?.find((m) => sameModel(m.name, s.model))?.size ?? 0;
      const total = narrator + judge.size;
      out.push(total > hw.gpus[0].vramTotal
        ? warn("judge-fit", `Narrator (${gib(narrator)}) + a GPU judge (${gib(judge.size)}) exceed VRAM (${gib(hw.gpus[0].vramTotal)})`, "Two Ollama processes don't coordinate GPU memory, so both end up partly on the CPU.", 'Run the judge on the CPU: "gpu": false in judge_instance.')
        : ok("judge-fit", `Narrator and GPU judge together fit in VRAM`));
    } else {
      const need = judge.size * 1.15;
      out.push(need < hw.ramFree
        ? ok("judge-fit", `The CPU judge needs ~${gib(need)} of RAM (${gib(hw.ramFree)} free)`)
        : warn("judge-fit", `The CPU judge needs ~${gib(need)} of RAM but only ${gib(hw.ramFree)} is free`, undefined, "Close other programs or use a smaller judge model."));
    }
  }
  return out;
}

// ---------- 6. around the proxy ----------
async function checkProxy({ sys, s }: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  if (await sys.portFree(s.port)) out.push(ok("port", `Port ${s.port} is free`));
  else {
    const me = await sys.http(`http://127.0.0.1:${s.port}/healthz`);
    out.push(me?.ok ? info("port", `Port ${s.port} is in use by a running proxy`) : warn("port", `Port ${s.port} is in use by something else`, undefined, "Stop it or set PORT."));
  }
  if (!s.redisUrl) out.push(info("redis", "REDIS_URL is not set", "Model responses go to logs/model-responses.jsonl instead of Redis.", "Run `docker compose up -d redis` and set REDIS_URL."));
  else {
    const r = await sys.redisPing(s.redisUrl);
    out.push(r.ok ? ok("redis", "Redis answers") : warn("redis", "Redis is configured but not reachable", r.error, "Run `docker compose up -d redis` (the proxy falls back to a log file meanwhile)."));
  }
  return out;
}

// ---------- 7. optional live probes ----------
interface LoadResult { ok: boolean; ms: number; offloadPct: number | null; error?: string }

/** Load `model` at `ctx` tokens with a 1-token chat, then read back from /api/ps how much landed on the CPU. */
async function loadAt(sys: Sys, base: string, model: string, ctx: number): Promise<LoadResult> {
  const t0 = Date.now();
  const r = await sys.http(`${base}/api/chat`, { method: "POST", body: { model, stream: false, options: { num_ctx: ctx, num_predict: 1 }, messages: [{ role: "user", content: "Say OK." }] } }, 300000);
  const ms = Date.now() - t0;
  if (!r?.ok || r.json?.error) return { ok: false, ms, offloadPct: null, error: r ? (r.json?.error ?? `HTTP ${r.status}`) : "no connection" };
  const ps = await sys.http(`${base}/api/ps`);
  const entry = (ps?.json?.models || []).find((m: any) => sameModel(m.name, model));
  const pct = entry?.size ? Math.round(((entry.size - entry.size_vram) / entry.size) * 100) : null;
  return { ok: true, ms, offloadPct: pct };
}

async function checkProbes({ sys, s, shared }: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";

  if (shared.backend === "ollama") {
    const base = shared.base!;
    const needs = contextNeeds(estimateTokens(s.fixedPromptText));
    const ctx0 = shared.effectiveCtx ?? Math.ceil(needs.comfortable / 1024) * 1024;
    const first = await loadAt(sys, base, s.model, ctx0);
    if (!first.ok) {
      out.push(fail("probe-narrator", `Narrator "${s.model}" could not be loaded and queried at context ${ctx0}`, first.error, "Check the model name and that the machine has enough memory; try a smaller context."));
    } else if (first.offloadPct == null) {
      out.push(info("probe-narrator", `Narrator "${s.model}" answered at context ${ctx0} in ${secs(first.ms)} (CPU/GPU split unknown)`));
    } else if (first.offloadPct < 2) {
      out.push(ok("probe-narrator", `Narrator "${s.model}" loaded 100% on the GPU at context ${ctx0} (${secs(first.ms)} including load)`));
      shared.recommendedCtx = null; // measured: no reduction needed
    } else {
      out.push(warn("probe-narrator", `Measured: at context ${ctx0}, ${first.offloadPct}% of "${s.model}" runs on the CPU`, `(loaded and answered in ${secs(first.ms)})`));
      // Find, by trying, a context that does fit fully on the GPU.
      let candidate = Math.floor((shared.recommendedCtx ?? ctx0 * 0.75) / 1024) * 1024;
      let verified: number | null = null;
      const tried: string[] = [];
      for (let attempt = 0; attempt < 4 && candidate >= needs.minimum; attempt++) {
        const r = await loadAt(sys, base, s.model, candidate);
        tried.push(`${candidate}: ${r.ok ? `${r.offloadPct ?? "?"}% on CPU` : "failed"}`);
        if (r.ok && r.offloadPct != null && r.offloadPct < 2) { verified = candidate; break; }
        candidate -= 2048;
      }
      if (verified) {
        shared.recommendedCtx = verified;
        out.push(ok("probe-ctx", `Verified: context ${verified} loads ${s.model} 100% on the GPU`, `Tried ${tried.join(", ")}.`));
      } else {
        out.push(warn("probe-ctx", `No context of at least ${needs.minimum} loaded ${s.model} fully on the GPU`, `Tried ${tried.join(", ") || "nothing (the lower bound is already above the estimate)"}.`, "Use a smaller or more heavily quantized narrator model, or free VRAM."));
      }
    }
  } else {
    const t0 = Date.now();
    const r = await sys.http(`${s.upstream}/chat/completions`, { method: "POST", body: { model: s.model, max_tokens: 1, stream: false, messages: [{ role: "user", content: "Say OK." }] } }, 180000);
    out.push(r?.ok ? ok("probe-narrator", `Narrator "${s.model}" answered a 1-token request in ${secs(Date.now() - t0)}`) : fail("probe-narrator", `Narrator "${s.model}" did not answer a test request`, r ? `HTTP ${r.status}` : "no connection", "Check the model name and the server."));
  }

  const jbase = s.judgeUrl || (s.judgeInstance ? `http://${s.judgeInstance.host || "127.0.0.1"}:${s.judgeInstance.port || 11435}` : shared.base || baseOf(s.upstream));
  const dedicated = Boolean(s.judgeUrl || s.judgeInstance);
  if (dedicated && !(await sys.http(`${jbase}/api/version`))?.ok) {
    out.push(info("probe-judge", `Judge probe skipped: nothing is running at ${jbase} yet`, "The proxy starts it with `npm start`, or run `npm run judge`; then re-run with --probe."));
    return out;
  }
  const t1 = Date.now();
  const j = await sys.http(`${jbase}/api/chat`, { method: "POST", body: { model: s.judgeModel, stream: false, options: { num_predict: 1, num_ctx: s.judgeNumCtx }, messages: [{ role: "user", content: "Say OK." }] } }, 180000);
  out.push(j?.ok && !j.json?.error ? ok("probe-judge", `Judge "${s.judgeModel}" answered in ${secs(Date.now() - t1)}`) : fail("probe-judge", `Judge "${s.judgeModel}" did not answer a test request`, j ? `HTTP ${j.status} ${j.json?.error ?? ""}` : "no connection", "Is the judge's Ollama running (npm run judge, or the proxy's own spawn)?"));
  return out;
}

// ---------- the runner ----------
export interface DoctorOptions {
  bail?: boolean;
  probe?: boolean;
  ignore?: string[];
}

export interface Report {
  findings: Finding[];
  hardware: Hardware;
  /** Context length and serve command worth trying, if the checks found a better setting. */
  suggestion?: { contextLength: number; command: string };
  /** True if --bail stopped the run early. */
  bailed: boolean;
}

export const isProblem = (f: Finding): boolean => f.level === "warn" || f.level === "fail";

export async function runDoctor(sys: Sys, s: Settings, opts: DoctorOptions = {}): Promise<Report> {
  const hw = await detectHardware(sys);
  const ctx: Ctx = { sys, s, hw, shared: {} };
  const ignored = new Set(opts.ignore || []);
  const findings: Finding[] = [];
  let bailed = false;

  const groups = [checkRuntime, checkHardware, checkGame, checkBackend, checkOllama, checkJudge, checkProxy, checkImages, checkSeating, checkTerms, checkVision, checkIdentity, checkMigrations, checkRehydrate, ...(opts.probe ? [checkProbes] : [])];
  outer: for (const group of groups) {
    for (let f of await group(ctx)) {
      if (ignored.has(f.id) && isProblem(f)) f = { ...f, level: "info", title: `${f.title} (ignored)` };
      findings.push(f);
      if (opts.bail && isProblem(f)) { bailed = true; break outer; }
    }
  }

  let suggestion: Report["suggestion"];
  const rec = ctx.shared.recommendedCtx;
  if (rec && ctx.shared.effectiveCtx && rec < ctx.shared.effectiveCtx) {
    const env: Record<string, string> = { ...(ctx.shared.serveEnv || {}), OLLAMA_CONTEXT_LENGTH: String(rec) };
    suggestion = { contextLength: rec, command: serveCommand(sys.platform, env) };
  }
  return { findings, hardware: hw, suggestion, bailed };
}

const KINDS = ["count", "sum", "min", "max", "argmax", "argmin"];
const leaves = (c: any, out: string[] = []): string[] => { if (c && typeof c === "object") { if (typeof c.field === "string") out.push(c.field); if (Array.isArray(c.conditions)) c.conditions.forEach((x: unknown) => leaves(x, out)); } return out; };

/** Problems in `calculated` and `phases` (empty = fine). */
export function calcPhaseProblems(cfg: Record<string, any>): string[] {
  const out: string[] = [];
  const calc = cfg.calculated && typeof cfg.calculated === "object" ? (cfg.calculated as Record<string, any>) : {};
  const names: string[] = [];
  for (const [name, d] of Object.entries(calc)) {
    const kinds = KINDS.filter((k) => d && d[k] !== undefined);
    if (kinds.length !== 1) { out.push(`calculated.${name} needs exactly one of ${KINDS.join(", ")}`); continue; }
    const of = String(d[kinds[0]]);
    if (!/^actors\.\*\.[\w-]+$/.test(of) && !names.includes(of)) out.push(`calculated.${name}: "${of}" must be actors.*.<field> or a calculated name declared above it`);
    if (kinds[0] === "count" && !/^actors\.\*\.[\w-]+$/.test(of)) out.push(`calculated.${name}: count needs actors.*.<list field>`);
    if (d.where !== undefined && kinds[0] !== "count") out.push(`calculated.${name}: where only works with count`);
    names.push(name);
  }
  if (cfg.phases === undefined) return out;
  const ph = cfg.phases && typeof cfg.phases === "object" && !Array.isArray(cfg.phases) ? (cfg.phases as Record<string, any>) : null;
  if (!ph) return [...out, "phases must be an object"];
  const steps = Object.keys(ph).filter((k) => k !== "start" && k !== "texts" && k !== "hook");
  if (ph.hook !== undefined && (typeof ph.hook !== "string" || !/^(hooks\/)?[\w.-]+\.m?js$/.test(ph.hook))) out.push("phases.hook must be a .mjs file name in the imeng folder (or in its hooks/ folder)");
  if (!steps.length) out.push("phases needs at least one phase");
  if (ph.start !== undefined && !steps.includes(ph.start)) out.push(`phases.start "${ph.start}" is not one of the phases`);
  for (const k of Object.keys(ph.texts ?? {})) if (!["here", "missing", "blocked", "gated"].includes(k)) out.push(`phases.texts.${k} is not a known text (here, missing, blocked, gated)`);
  const allowed = cfg.allowed_values?.["game.phase"];
  for (const k of steps) {
    const d = ph[k];
    if (!d || typeof d !== "object") { out.push(`phases.${k} must be an object`); continue; }
    const rawNext = Array.isArray(d.next) ? d.next : d.next === undefined ? [] : [d.next];
    for (const r of rawNext) if (r && typeof r === "object" && (typeof r.to !== "string" || (r.ops !== undefined && !Array.isArray(r.ops)))) out.push(`phases.${k}.next: a route needs "to" (a phase) and, if it has "ops", a list of operations`);
    const next = rawNext.map((r: any) => (r && typeof r === "object" ? r.to : r));
    if (d.gated !== undefined && d.gated !== false) {
      if (d.gated !== true && (typeof d.gated !== "object" || Array.isArray(d.gated))) out.push(`phases.${k}.gated must be true or {when, blocks}`);
      else if (d.gated !== true) {
        for (const b of Array.isArray(d.gated.blocks) ? d.gated.blocks : []) if (!GATE_BLOCKS.includes(b)) out.push(`phases.${k}.gated.blocks: "${b}" is not one of ${GATE_BLOCKS.join(", ")}`);
        if (d.gated.when !== undefined) out.push(...conditionProblems(d.gated.when, false).map((p) => `phases.${k}.gated.when: ${p}`));
      }
      if (!next.some((n: unknown) => typeof n === "string" && n !== "@return")) out.push(`phases.${k} is gated but has no next route: a gate needs a way out`);
    }
    if (d.max_rounds !== undefined && (d.gated === undefined || d.gated === false)) out.push(`phases.${k}.max_rounds only works with gated`);
    if (typeof d.max_rounds === "string" && !/^(imeng|game)\.[\w-]+$/.test(d.max_rounds)) out.push(`phases.${k}.max_rounds must be a number or a state path (imeng.<name>)`);
    for (const n of next) if (!steps.includes(n) && !(n === "@return" && d.interrupt === true)) out.push(`phases.${k}.next: "${n}" is not one of the phases${n === "@return" ? " (\"@return\" is only for a phase with interrupt: true)" : ""}`);
    if (d.silent === true && !next.length) out.push(`phases.${k} is silent but has no next, so the game would stop in it`);
    if (d.silent === true && d.interrupt === true) out.push(`phases.${k} cannot be both silent and interrupt`);
    for (const [an, a] of Object.entries((d.actions && typeof d.actions === "object" ? d.actions : {}) as Record<string, any>)) if (!a || !Array.isArray(a.allow)) out.push(`phases.${k}.actions.${an} needs an allow list of paths`);
    const req = Array.isArray(d.require) ? d.require : d.require === undefined ? [] : [d.require];
    for (const [label, c] of [...req.map((r: unknown, i: number) => [`require[${i}]`, r]), ...(["enter_when", "exit_when"] as const).filter((x) => d[x] !== undefined).map((x) => [x, d[x]])] as [string, unknown][]) {
      out.push(...conditionProblems(c, false).map((p) => `phases.${k}.${label}: ${p}`));
      for (const f of leaves(c)) if (f.startsWith("game.calc.") && !names.includes(f.split(".")[2])) out.push(`phases.${k}.${label}: ${f} is not a calculated value`);
    }
    if (d.exit_when !== undefined && !next.length) out.push(`phases.${k} has exit_when but no next`);
    if (Array.isArray(allowed) && !allowed.includes(k)) out.push(`allowed_values game.phase does not list the phase "${k}"`);
  }
  return out;
}
