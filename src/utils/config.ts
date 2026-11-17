import { GATE_BLOCKS } from "./gate-blocks.js";
import fs from "node:fs";
import { loadValidator } from "./validator.js";
import { readGameFile } from "./game-file.js";
import path from "node:path";
import type { GameConfig, IdDomain, RefRule, Fact, FactAccess, FactTrigger } from "./types.js";
import { parseDurationMs, parseGameDuration, CLOCK_UNITS } from "./durations.js";
import type { ClockUnit } from "./durations.js";
import { checkConfig } from "./config-schema.js";
import { systemPromptPath, experimentPerChat, telemetryEnabled } from "./early-flags.js";

/*
 * Generic "game files" proxy configuration.
 *
 * A game is a directory (IMENG_PATH, default ./imengs/dungeon-game) containing:
 *   SYSTEM_PROMPT.md  - the narrator / host / game-master instructions (required)
 *   config.json         - optional settings (see docs/CONFIGURATION.md)
 */

export const UPSTREAM = process.env.UPSTREAM || "http://localhost:11434/v1";
export const IMENG_PATH = path.resolve(process.env.IMENG_PATH || process.env.GAME_DIR || "./imengs/dungeon-game");
/** The folder holding every imeng this server can run (for the "what is this?" intro): IMENGS_ROOT, else the `imengs` folder above IMENG_PATH, else ./imengs. */
export const IMENGS_ROOT = path.resolve(process.env.IMENGS_ROOT || (() => { let d = IMENG_PATH; while (d !== path.dirname(d)) { if (path.basename(d) === "imengs") return d; d = path.dirname(d); } return "./imengs"; })());
/** A IMENG_PATH that was set on purpose but does not exist is a mistake (a typo would silently run a built-in default game). */
export function gameDirError(explicit: string | undefined, dir: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  return explicit && !exists(dir) ? `IMENG_PATH "${explicit}" does not exist (looked for ${dir}). Check the folder name.` : null;
}
const badGameDir = gameDirError(process.env.IMENG_PATH || process.env.GAME_DIR, IMENG_PATH);
if (badGameDir) { console.error(badGameDir); process.exit(1); }
export const PORT = Number(process.env.PORT || 3001);
// INTERFACES: which ways in to start (modules/<name>), comma separated. Default "openwebui" (an OpenAI-compatible API under /v1).
export const INTERFACES: string[] = (process.env.INTERFACES || "openwebui").split(",").map((x) => x.trim()).filter(Boolean);
// SAVE_COALESCE_MS (default 0 = write a session file at once, as before): when above 0, saves are written in the background at most once
// per interval per session (the newest state wins), unchanged states are not rewritten, and everything pending is written on a clean exit.
export const SAVE_COALESCE_MS = Math.max(0, Number(process.env.SAVE_COALESCE_MS || 0)) || 0;
export const SAVE_DIR = path.resolve(process.env.SAVE_DIR || "./saves");
// Public-facing hardening. PROXY_API_KEY: when set, /v1 requires `Authorization: Bearer <key>`.
export const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
export const ENABLE_DEBUG = !["0", "false", "off"].includes((process.env.ENABLE_DEBUG ?? "1").toLowerCase());

function readOptional(file: string): string | null {
  try { return fs.readFileSync(path.join(IMENG_PATH, file), "utf8"); } catch { return null; }
}

const PROMPT_FILE = systemPromptPath();
export const SYSTEM_PROMPT: string =
  (PROMPT_FILE ? (() => { try { return fs.readFileSync(path.resolve(PROMPT_FILE), "utf8"); } catch { console.error(`SYSTEM_PROMPT_PATH "${PROMPT_FILE}" could not be read`); process.exit(1); } })() : null) ||
  readOptional("SYSTEM_PROMPT.md") ||
  (() => { try { return fs.readFileSync("./SYSTEM_PROMPT.md", "utf8"); } catch { return null; } })() ||
  "You are the narrator of a text game. Keep replies under 150 words and end each turn with the player's options.";

let rawConfig: unknown;
export let GAME_FILE: string | null = null;
try { const r = await readGameFile(IMENG_PATH); rawConfig = r.raw; GAME_FILE = r.file; }
catch (e) { console.error(`game settings: ${(e as Error).message}`); process.exit(1); }
const checked = checkConfig(rawConfig);
for (const w of checked.warnings) console.warn(`config.json: ${w}`);
if (checked.errors.length) { console.error(`config.json has problems:\n- ${checked.errors.join("\n- ")}`); process.exit(1); }
/** The state's `game` branch is called `imeng` in what people and models see; every path in the settings may use either. Inside the engine it stays `game`. */
export function imengToGame<T>(v: T): T {
  if (typeof v === "string") return (/^imeng\.[\w.*-]+$/.test(v) ? "game." + v.slice(6) : v) as T;
  if (Array.isArray(v)) return v.map(imengToGame) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [/^imeng\.[\w.*-]+$/.test(k) ? "game." + k.slice(6) : k, imengToGame(x)])) as T;
  return v;
}
const loaded = imengToGame(checked.config) as GameConfig;
export const config: GameConfig = loaded;
/** The schema_version config.json declares (before it is upgraded in memory); saved sessions are stamped with it. */
export const GAME_SCHEMA_VERSION: number = checked.version;
/** SESSION_SCHEMA: a stored session from another schema_version with no migration path. refuse (default): the server does not start. warn: it starts and says so. off: no check. */
export const SESSION_SCHEMA: "refuse" | "warn" | "off" = process.env.SESSION_SCHEMA === "warn" || process.env.SESSION_SCHEMA === "off" ? process.env.SESSION_SCHEMA : "refuse";
/** The game's own version (`version` in its package.json, optional); saves record it so a major change can be noticed. */
export const GAME_VERSION: string | null = (() => { try { const v = JSON.parse(readOptional("package.json") || "{}").version; return typeof v === "string" ? v : null; } catch { return null; } })();
export const MODEL = process.env.OLLAMA_MODEL || "gemma4:26b";
export const MODEL_ID = loaded.model_id || "text-game";
// actor_history_limit is the name; history_limit is the old name (v1.1) and still works
export const HISTORY_LIMIT = config.actor_history_limit ?? config.history_limit ?? 20;
export const EVENTS_LIMIT = config.events_limit ?? 30;
export const STATE_RULES = config.state_rules || "";
// actor_defaults_from: {"chips": "imeng.stack"}: a new actor (a real player joining, an NPC added) starts with the value of that game field, when it is a number, instead of the template's.
const adf: any = config.actor_defaults_from && typeof config.actor_defaults_from === "object" && !Array.isArray(config.actor_defaults_from) ? config.actor_defaults_from : {};
export const ACTOR_DEFAULTS_FROM: Record<string, string> = Object.fromEntries(Object.entries(adf).filter(([k, v]) => /^[\w-]+$/.test(k) && typeof v === "string" && /^(imeng|game)\.[\w-]+$/.test(v as string)).map(([k, v]) => [k, (v as string).replace(/^imeng\./, "game.")]));
export const ACTOR_TEMPLATE = config.actor_template || { name: "", statuses: [], history: [] };
// limits: clamp numeric actor fields, e.g. {"<field>":{"min":0,"max":10}}
export const LIMITS = config.limits || {};
// exit_when: auto-exit actors, e.g. [{"field":"<field>","lte":0,"reason":"..."}]
export const EXIT_WHEN = config.exit_when || [];
// allowed_values: a field that can only hold one of a fixed list, e.g. {"game.<field>":["a","b"],"<actor field>":[...]}
export const ALLOWED_VALUES: Record<string, unknown[]> = Object.fromEntries(Object.entries(config.allowed_values || {}).filter(([, v]) => Array.isArray(v) && v.length));
// sticky_fields: (an empty field takes its first value at once) a field that changes only after the same new value was set on N turns in a row, e.g. {"game.<field>":2}
// field_evidence: an actor field changes only when the narration itself contains a phrase, e.g. {"score": "point to {name}"}: a regular expression (case-insensitive) in which {name} is the actor's name, address or id
export const FIELD_EVIDENCE: Record<string, string> = Object.fromEntries(Object.entries(config.field_evidence || {}).filter(([k, v]) => typeof v === "string" && v && !k.includes(".")).map(([k, v]) => [k, v as string]));
export const STICKY_FIELDS: Record<string, number> = Object.fromEntries(Object.entries(config.sticky_fields || {}).filter(([, n]) => Number.isInteger(n) && n >= 1).map(([k, n]) => [k, n as number]));
// unique_fields: actor list fields that behave as sets (push of a value already there does nothing; first entry stays)
export const UNIQUE_FIELDS = new Set<string>(Array.isArray(config.unique_fields) ? config.unique_fields.filter((f) => typeof f === "string") : []);
// actor_ref_fields: fields that hold an actor. "game.<field>" names a shared field; a bare name is a field of every actor.
// game.current_actor is always one. A write is checked (null or an existing actor; "actors.<id>", another case or the actor's name are accepted and stored as the id),
// and the field is cleared when the actor it names leaves the game. e.g. ["game.targeter","game.target","rival"]
/** Fields only the server writes: never writable by an op, never readable through an address, never an actor reference. */
export const PROTECTED_GAME_PATHS = ["game.turn", "game.phase_rounds", "game.escrow", "game.escrow_total", "game.private_to", "game.exited_game", "game.rules", "game.blocked", "game.pending", "game.game_turn", "game.fired", "game.effects", "game.effect_seq", "game.calc", "game.crossing", "game.area", "game.resume", "game.attraction", "game.show_minutes", "game.asked_blocks", "game.royals", "game.locked", "game.bans", "game.events_rolled", "game.ante_start", "game.hazard_done", "game.hazard_mod", "game.hazard_count", "game.shelter", "game.moved_to", "game.audience_energy", "game.shuffled", "game.shuffle_step", "game.acted", "game.raises", "game.button", "game.winners", "game.bet_log", "game.contrib", "game.pots", "game.hands_played", "game.blind_level", "game.blind_base", "game.tips", "game.tip_idle", "game.tip_mark", "game.tip_notice", "game.reset_start", "game.npc_stats", "game.last_raiser", "game.leavers", "game.forfeit", "game.sense", "game.seen", "game.weak_raisers", "game.strong_raisers", "game.started"];
export const PROTECTED_ACTOR_FIELD_NAMES = ["controlled_by", ...(config.goals && typeof config.goals === "object" ? ["goals_set", "goals_done"] : [])];
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const okRefField = (f: unknown): f is string => {
  if (typeof f !== "string" || !f.trim()) return false;
  const parts = f.split(".");
  const bad = parts.some((k) => !k || UNSAFE_KEYS.has(k))
    || (parts[0] === "game" ? parts.length !== 2 || PROTECTED_GAME_PATHS.includes(f) : parts.length !== 1 || PROTECTED_ACTOR_FIELD_NAMES.includes(f));
  if (bad) console.warn(`actor_ref_fields: ignoring "${f}" (use "game.<field>" or one actor field name; server-owned fields are not allowed)`);
  return !bad;
};
export const ACTOR_REF_FIELDS = new Set<string>(["game.current_actor", ...(Array.isArray(config.actor_ref_fields) ? config.actor_ref_fields.filter(okRefField) : [])]);

// id_domains: places where entities with ids live. "actors" always is one. Others: {"at":"game.items"} is a map (key = id);
// add "key":"id" for an array of objects with that field. mint/when/from: how ids are made (see utils/ids.ts).
// refs: fields that must hold ids of a domain: {"game.location":{"to":"locations"},"actors.*.inventory":{"to":"items","repeat":false},"actors.*.counts":{"keys_to":"items"}}
const warn = (m: string): void => console.warn(m);
const safeSeg = (k: string): boolean => !!k && !UNSAFE_KEYS.has(k) && !/[\s'"\\/]/.test(k);
const parseAt = (name: string, at: unknown): string[] | null => {
  const parts = typeof at === "string" ? at.split(".") : [];
  const ok = parts.every(safeSeg) && ((parts.length === 1 && parts[0] === "actors" && name === "actors") || (parts.length === 2 && parts[0] === "game" && !PROTECTED_GAME_PATHS.includes(at as string)));
  if (!ok) warn(`id_domains.${name}: "at" must be ${name === "actors" ? '"actors"' : '"game.<field>"'}; ignored`);
  return ok ? parts : null;
};
export const ID_DOMAINS: Record<string, IdDomain> = Object.create(null);
ID_DOMAINS.actors = { name: "actors", at: ["actors"], from: "name", when: "creation" };
for (const [name, raw] of Object.entries((config.id_domains && typeof config.id_domains === "object" ? config.id_domains : {}) as Record<string, any>)) {
  if (!safeSeg(name) || !raw || typeof raw !== "object") { warn(`id_domains: ignoring "${name}"`); continue; }
  const at = name === "actors" ? ID_DOMAINS.actors.at : parseAt(name, raw.at);
  if (!at) continue;
  const key = typeof raw.key === "string" && safeSeg(raw.key) ? raw.key : undefined;
  if (name === "actors" && key) { warn("id_domains.actors: actors are a map; \"key\" ignored"); }
  ID_DOMAINS[name] = {
    name, at, key: name === "actors" ? undefined : key,
    from: typeof raw.from === "string" && raw.from ? raw.from : "name",
    when: raw.when === "collision" || raw.when === "change" ? raw.when : "creation",
    mint: raw.mint && typeof raw.mint === "object" ? raw.mint : undefined,
  };
}
// calculated: values the server works out after every change (never an op, never the model): {"goals_done": {"count": "actors.*.goals", "where": {"done": true}}, "leader": {"argmax": "goals_done"}}
//   count: per actor, the items of a list field (only those matching `where` when given); sum / min / max: one number over a calculated map or a numeric actor field;
//   argmax / argmin: the actor id on top (null on a tie, or when the top is below `at_least`, default 1). Written to game.calc.<name>; read it in conditions as "game.calc.<name>".
export type CalcKind = "count" | "sum" | "min" | "max" | "argmax" | "argmin";
export interface CalcDef { kind: CalcKind; of: string; where?: Record<string, unknown>; at_least: number }
const CALC_KINDS: CalcKind[] = ["count", "sum", "min", "max", "argmax", "argmin"];
export const CALCULATED: Record<string, CalcDef> = Object.create(null);
for (const [name, raw] of Object.entries((config.calculated && typeof config.calculated === "object" && !Array.isArray(config.calculated) ? config.calculated : {}) as Record<string, any>)) {
  const kind = CALC_KINDS.find((k) => raw && typeof raw[k] === "string" && raw[k]);
  if (!safeSeg(name) || !kind) { warn(`calculated: ignoring "${name}" (needs one of ${CALC_KINDS.join(", ")} set to a field or an earlier calculated name)`); continue; }
  CALCULATED[name] = { kind, of: raw[kind], where: raw.where && typeof raw.where === "object" && !Array.isArray(raw.where) ? raw.where : undefined, at_least: Number.isFinite(Number(raw.at_least)) ? Number(raw.at_least) : 1 };
}
// phases: the steps a game goes through, gated in code. {"start":"registration","texts":{...},"registration":{"require":[conditions],"next":"playing"},"playing":{"enter_when":..,"exit_when":..,"next":["finale"]}}
//   game.phase can only move along `next`, and only when the phase being left has all its `require` conditions true and the one being entered has `enter_when` true.
//   exit_when true: the server moves on by itself (to the first `next` that is allowed).
//   actions: what a player's words may do in this phase: {"attack":{"describe":"hits an enemy","allow":["actors.*.hp"]}}. A phase with actions gates ops by path (only the paths an action allows, and
//   game.phase) and sends a message that matches no action to the off-phase reply. A phase without actions is not gated. `allow` (a list of paths) works the same for a phase-wide set of paths.
//   writers: who may change a value in this phase: {"hp": ["npc"], "game.place": ["producer"]}. A key is an actor field (the listed controllers user/npc may change it for their own actors; anyone else's is put back)
//   or a game.* path (only "narrator" lets the narrator change it; without it only the server and the producer's commands can).
//   silent: a pass-through step: the server moves on along `next` in the same turn (the first step whose conditions hold) with no reply of its own.
//   interrupt: can be entered from any phase; the phase it interrupted is kept (game.resume) and "@return" in its `next` goes back to it.
export interface PhaseAction { describe: string; allow: string[] }
export interface PhaseDef { writers: Record<string, string[]>; require: unknown[]; enter_when?: unknown; exit_when?: unknown; next: string[]; routes: Record<string, unknown[]>; gated: { when?: unknown; blocks: string[] } | null; privateNarration: { line: string; when?: unknown; unless?: unknown } | null; maxRounds: number | string; note: string; actions: Record<string, PhaseAction>; allow: string[]; silent: boolean; interrupt: boolean }
/** `next` is a name or a list of names and/or {to, ops}: a route, with operations the server runs the moment the game arrives in `to`. */
const routeList = (n: unknown): { to: string; ops: unknown[] }[] => (Array.isArray(n) ? n : typeof n === "string" ? [n] : []).flatMap((r: unknown) => typeof r === "string" ? [{ to: r, ops: [] }] : r && typeof r === "object" && typeof (r as any).to === "string" ? [{ to: (r as any).to as string, ops: Array.isArray((r as any).ops) ? ((r as any).ops as unknown[]).slice(0, 50) : [] }] : []);
const gateOf = (g: any, hasRoute: boolean): { when?: unknown; blocks: string[] } | null => {
  if (!hasRoute || !g) return null;
  if (g === true) return { blocks: [...GATE_BLOCKS] };
  if (typeof g !== "object" || Array.isArray(g)) return null;
  return { when: g.when, blocks: (Array.isArray(g.blocks) ? g.blocks : GATE_BLOCKS).filter((b: unknown): b is string => typeof b === "string" && GATE_BLOCKS.includes(b)) };
};
const ph: any = config.phases && typeof config.phases === "object" && !Array.isArray(config.phases) ? config.phases : null;
const PHASE_RESERVED = new Set(["start", "texts", "hook"]);
export const PHASES: Record<string, PhaseDef> | null = ph
  ? Object.fromEntries(Object.entries(ph).filter(([k, v]) => !PHASE_RESERVED.has(k) && v && typeof v === "object" && safeSeg(k)).map(([k, v]: [string, any]) => [k, {
      require: Array.isArray(v.require) ? v.require : v.require ? [v.require] : [],
      enter_when: v.enter_when, exit_when: v.exit_when,
      next: routeList(v.next).map((r) => r.to),
      routes: Object.fromEntries(routeList(v.next).filter((r) => r.ops.length).map((r) => [r.to, r.ops])),
      gated: gateOf(v.gated, routeList(v.next).some((r) => r.to !== "@return")), // a lock needs a way out: a gated phase with no next route is not gated
      privateNarration: v.private_narration && typeof v.private_narration === "object" && typeof v.private_narration.line === "string" && v.private_narration.line.trim() && v.private_narration.recipients === "escrow" ? { line: String(v.private_narration.line).slice(0, 500), when: v.private_narration.when, unless: v.private_narration.unless } : null,
      maxRounds: typeof v.max_rounds === "string" && /^(imeng|game)\.[\w-]+$/.test(v.max_rounds) ? v.max_rounds.replace(/^imeng\./, "game.") : Math.min(1000, Math.max(0, Math.floor(Number(v.max_rounds)) || 0)),
      note: typeof v.note === "string" ? v.note : "",
      actions: Object.fromEntries(Object.entries(v.actions && typeof v.actions === "object" && !Array.isArray(v.actions) ? v.actions : {}).filter(([n]) => safeSeg(n)).map(([n, a]: [string, any]) => [n, { describe: typeof a?.describe === "string" ? a.describe : n, allow: (Array.isArray(a?.allow) ? a.allow : []).filter((x: unknown): x is string => typeof x === "string") }])),
      allow: (Array.isArray(v.allow) ? v.allow : []).filter((x: unknown): x is string => typeof x === "string"),
      writers: Object.fromEntries(Object.entries(v.writers && typeof v.writers === "object" && !Array.isArray(v.writers) ? v.writers : {}).map(([k, l]) => [k, (Array.isArray(l) ? l : [l]).map(String)])),
      silent: v.silent === true,
      interrupt: v.interrupt === true,
    }]))
  : null;
export const PHASE_HOOK: string = typeof ph?.hook === "string" ? ph.hook : "";
const phaseNames = PHASES ? Object.keys(PHASES) : [];
export const PHASE_START: string = ph && typeof ph.start === "string" && phaseNames.includes(ph.start) ? ph.start : phaseNames[0] ?? "";
export const PHASE_TEXTS = {
  here: "The game is in the {phase} phase.",
  missing: "It cannot move on to {next} until this is done: {what}.",
  blocked: "the game cannot move to {to} yet",
  gated: "The table is held in the {phase} phase: it cannot be moved on until this is over (it can only go to {next}).",
  ...Object.fromEntries(Object.entries(ph?.texts && typeof ph.texts === "object" ? ph.texts : {}).filter(([, v]) => typeof v === "string")),
} as Record<"here" | "missing" | "blocked" | "gated", string>;
// tone_fields: actor string fields (description, outfit, address_as...) that carry a character's voice. They are never masked by `pii`, and the narrator is shown them as a CHARACTER VOICE block
// so personality cues survive the PII masking. role_field (default "role") names the actor field that holds a role; field_roles says which roles may have each field changed
// ({"warmth":["contestant"]}): an op on that field of an actor with another role is refused, so the Host is never covered in gak.
export const TONE_FIELDS: string[] = (Array.isArray(config.tone_fields) ? config.tone_fields : []).filter((f: unknown): f is string => typeof f === "string" && safeSeg(f));
export const ROLE_FIELD: string = typeof config.role_field === "string" && safeSeg(config.role_field) ? config.role_field : "role";
export const FIELD_ROLES: Record<string, string[]> = Object.fromEntries(Object.entries(config.field_roles && typeof config.field_roles === "object" ? config.field_roles : {}).filter(([k, v]) => safeSeg(k) && Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")]));
// dating: the dating-show rules in code (see src/utils/dating.ts). After each round a small judge reads what was said and done and names who warmed or cooled toward whom, with a quoted line;
// code checks the quote is really in the round, then moves game.attraction (directed, -1 to 3; any quoted warmth takes -1 or 0 to 1, then one level per check). The narrator never sees game.attraction.
export const DATING = config.dating && typeof config.dating === "object" ? {
  statusField: typeof (config.dating as any).status_field === "string" ? (config.dating as any).status_field : "relationship",
  ageField: typeof (config.dating as any).age_field === "string" ? (config.dating as any).age_field : "age",
  roleField: typeof (config.dating as any).role_field === "string" ? (config.dating as any).role_field : "role",
  contestantRole: typeof (config.dating as any).contestant_role === "string" ? (config.dating as any).contestant_role : "contestant",
  npcStatus: ((o: any) => { const d = { single: 0.7, dating: 0.2, married: 0.1 } as Record<string, number>; if (!o || typeof o !== "object") return d; const e = Object.entries(o).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) >= 0).map(([k, v]) => [k, Number(v)] as [string, number]); return e.length && e.some(([, v]) => v > 0) ? Object.fromEntries(e) : d; })((config.dating as any).npc_status),
  finale: { pair: typeof (config.dating as any).finale?.pair === "string" && (config.dating as any).finale.pair.trim() ? String((config.dating as any).finale.pair).slice(0, 1500) : "", none: typeof (config.dating as any).finale?.none === "string" && (config.dating as any).finale.none.trim() ? String((config.dating as any).finale.none).slice(0, 1500) : "" },
  notesAfter: Number.isFinite(Number((config.dating as any).notes_after)) ? Math.max(1, Math.floor(Number((config.dating as any).notes_after))) : 2,
} : null;
// question: the open question is kept in the state (game.asked = the id of the actor who was asked; the narrator writes it, and clears it when it is answered). While it is open, a message from a
// different real player does not count: it stays in the chat, nothing changes, and they get `text` ({name} is who was asked). In single player a message from the user cannot answer a question put to an NPC.
export const QUESTION = config.question && typeof config.question === "object" ? {
  field: typeof (config.question as any).field === "string" && /^game\.[\w-]+$/.test((config.question as any).field) ? ((config.question as any).field as string).slice(5) : "asked",
  text: typeof (config.question as any).text === "string" && (config.question as any).text ? (config.question as any).text as string : "You were not the one asked: that question is for {name}.",
} : null;
// off_phase: what happens to a message that matches none of the current phase's actions. mode: "hush" (default: a fixed reply from `texts`, chosen at random, no model call, nothing changes),
// or "ignore" (a bare "..." and nothing changes). Only phases that list `actions` have an off-phase.
const op_: any = config.off_phase && typeof config.off_phase === "object" ? config.off_phase : {};
export const OFF_PHASE = {
  mode: (["hush", "ignore"].includes(op_.mode) ? op_.mode : "hush") as "hush" | "ignore",
  texts: (Array.isArray(op_.texts) && op_.texts.some((t: unknown) => typeof t === "string" && t) ? op_.texts.filter((t: unknown): t is string => typeof t === "string" && !!t) : ["Hush, you.", "Not now.", "Shh. Focus.", "That is not what is happening right now."]) as string[],
};
const toPattern = (path: string): string[] | null => {
  const parts = path.split(".");
  const bad = !parts.every((k) => k === "*" || safeSeg(k))
    || (parts[0] === "game" ? parts.length < 2 || PROTECTED_GAME_PATHS.some((q) => path === q || path.startsWith(q + ".")) : parts[0] !== "actors" || parts.length < 3 || PROTECTED_ACTOR_FIELD_NAMES.includes(parts[2]));
  return bad ? null : parts;
};
export const REFS: RefRule[] = [];
const addRef = (path: string, r: Omit<RefRule, "path" | "pattern">): void => {
  const pattern = toPattern(path), target = r.to ?? r.keysTo;
  if (!pattern || !target || !ID_DOMAINS[target]) { warn(`refs: ignoring "${path}" (needs a "game.<field>" or "actors.<id or *>.<field>" path and an existing id domain)`); return; }
  if (REFS.some((x) => x.path === path)) return;
  REFS.push({ path, pattern, ...r });
};
for (const f of ACTOR_REF_FIELDS) addRef(f.startsWith("game.") ? f : `actors.*.${f}`, { to: "actors", repeat: false });
for (const [path, raw] of Object.entries((config.refs && typeof config.refs === "object" ? config.refs : {}) as Record<string, any>)) {
  if (raw && typeof raw.to === "string") addRef(path, { to: raw.to, repeat: raw.repeat === true });
  else if (raw && typeof raw.keys_to === "string") addRef(path, { keysTo: raw.keys_to, repeat: false });
  else warn(`refs: ignoring "${path}" (needs "to" or "keys_to")`);
}
// field_access: who may do what with a field (keys like allowed_values: "game.<field>" or an actor field; a key covers what is inside the field too). "normal" (or not listed / null): no restriction.
//   "read-only": the model's ops cannot write it (path, add_actor); it can still be copied from with an address in a value.
//   "write-only": ops can write it by path, but its address can never appear in a value (no copying it elsewhere).
export const FIELD_ACCESS: Readonly<Record<string, "read-only" | "write-only">> = Object.freeze(Object.assign(Object.create(null) as Record<string, "read-only" | "write-only">,
  Object.fromEntries(Object.entries(config.field_access || {}).filter(([, v]) => v === "read-only" || v === "write-only"))));
// decrease_locks: e.g. [{"field":"<field>","while":{"field":"<other>","gt":0}}]: <field> cannot go down in a turn that started with <other> > 0
export const DECREASE_LOCKS = Array.isArray(config.decrease_locks) ? config.decrease_locks : [];
// exit_group_when: when `share` (0-1, default 1) of the actors still in that have the field meet lte/gte, everyone still in exits
export const EXIT_GROUP_WHEN = config.exit_group_when || [];
// early_sync (default false): read the player's own message into the state while the narrator is still writing
export const EARLY_SYNC = config.early_sync === true;
// reasoning: "hide" (default; strip the model's thinking), "show", or "off" (ask the model not to think)
export const REASONING = config.reasoning || "hide";
// hide_state_echo (default false): remove the server's own state/dice blocks if the narrator repeats them
export const HIDE_STATE_ECHO = config.hide_state_echo === true;
// <private>...</private> in a narrator reply is for the narrator and the characters, never the player. SHOW_PRIVATE=1 shows it (debugging). A reply that is only
// private text shows private_only_reply instead (config.json only; the models cannot change it).
export const HIDE_PRIVATE = !["1", "true", "on"].includes((process.env.SHOW_PRIVATE ?? "").toLowerCase());
// private_guidance (config.json): how the actors of this game use the private channel, in words; the judge that reads private messages and the narrator are told it.
export const PRIVATE_GUIDANCE = typeof config.private_guidance === "string" ? config.private_guidance.trim().slice(0, 1500) : "";
export const PRIVATE_ONLY_REPLY = typeof config.private_only_reply === "string" && config.private_only_reply.trim() ? config.private_only_reply.trim() : "...";
// state_notes (default false): plain-language notes beside the JSON state; field_words: words for numeric fields
export const STATE_NOTES = config.state_notes === true;
export const FIELD_WORDS = config.field_words || {};
export const ALIAS_FIELDS: string[] = Array.isArray(config.alias_fields) ? config.alias_fields.filter((f) => typeof f === "string") : [];
// compaction: once the prompt is about at_tokens (chars / 4), turns older than keep_turns become a verified recap
const comp = config.compaction;
export const COMPACTION = comp && Number(comp.at_tokens) > 0
  ? { at_tokens: Number(comp.at_tokens), keep_turns: Math.max(1, comp.keep_turns ?? 6), max_chars: Math.max(500, comp.max_chars ?? 2500), verify: comp.verify === "fields" ? "fields" as const : "judge" as const, verify_fields: Array.isArray(comp.verify_fields) ? comp.verify_fields.filter((f) => typeof f === "string") : [] }
  : null;
// Machine guards (env, every game): the most the hardware may be asked to carry. Unset = no ceiling.
const posInt = (v: string | undefined): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
export const CONTEXT_MAX_TOKENS = posInt(process.env.CONTEXT_MAX_TOKENS);
export const CONTEXT_MAX_ROUNDS = posInt(process.env.CONTEXT_MAX_ROUNDS);
export const TOO_LONG_REPLY = typeof config.too_long_reply === "string" && config.too_long_reply.trim() ? config.too_long_reply : "That message is too long for this game. Please shorten it and send it again.";
// game_turn (config.json): a game turn is one beat of the game as the game defines it (a show round, a quarter, a match), separate from the chat round.
//   advance: round (default: every round is a game turn) | field (a game turn passes when the numeric game field named in `field` goes up) | judged
//   (a small judge decides after each round from `rule`, in words). word: what the game calls it (turn, round, segment, quarter, game, match, or any word).
export type TurnAdvance = "round" | "field" | "judged";
const gt: any = config.game_turn && typeof config.game_turn === "object" && !Array.isArray(config.game_turn) ? config.game_turn : null;
export const GAME_TURN = gt
  ? {
      advance: (["field", "judged"].includes(gt.advance) ? gt.advance : "round") as TurnAdvance,
      field: typeof gt.field === "string" && gt.field.startsWith("game.") ? gt.field.slice(5) : "",
      rule: typeof gt.rule === "string" ? gt.rule.slice(0, 1500) : "",
      word: typeof gt.word === "string" && /^[A-Za-z][A-Za-z -]{0,24}$/.test(gt.word.trim()) ? gt.word.trim().toLowerCase() : "turn",
    }
  : null;
// turn_events: things that happen on a game turn. {id, at | every, if, text, set, end}. at: the moment the game turn becomes N; every: each Nth; if: a condition
//   (as in exit_when) over the state; text: told to the narrator once; set: {"game.path": value} through the usual checks; end: close the game with `text`.
export interface TurnEvent { id: string; at: number; every: number; if?: unknown; text: string; set: Record<string, unknown>; end: boolean }
export const TURN_EVENTS: TurnEvent[] = GAME_TURN && Array.isArray(config.turn_events)
  ? config.turn_events.flatMap((e: any, i: number): TurnEvent[] => e && typeof e === "object" && (Number(e.at) >= 1 || Number(e.every) >= 1)
      ? [{ id: typeof e.id === "string" && e.id ? e.id : `ev${i + 1}`, at: Math.floor(Number(e.at)) || 0, every: Math.floor(Number(e.every)) || 0, if: e.if, text: typeof e.text === "string" ? e.text : "", set: e.set && typeof e.set === "object" && !Array.isArray(e.set) ? e.set : {}, end: e.end === true }]
      : [])
  : [];
// deck: on every round played in `phase` the server draws one card (top of the deck, put back into the bottom half afterwards) and tells the narrator the card and its strength multiplier,
// so luck is rolled by code. `note` replaces the default instruction.
export const DECK = config.deck && typeof config.deck === "object" && typeof (config.deck as any).phase === "string" && (config.deck as any).phase
  ? { phase: (config.deck as any).phase as string, hand: Number.isFinite(Number((config.deck as any).hand)) ? Math.min(7, Math.max(0, Math.floor(Number((config.deck as any).hand)))) : 0, note: typeof (config.deck as any).note === "string" ? (config.deck as any).note as string : "Resolve what the player attempts at this strength: a low multiplier is weak or partial, 1 is normal, above 1 is strong. State the card in the story." } : null;
// credit: a player at or below `empty` in `field` (default chips at 0) is busted and given a re-entry code shown only to them (see credit.ts). `start` is what they come back with (and
// what a code costs in credit), `debt_limit` the most the owner may lend one player, `code_ttl` how long a code works, `frozen_borrow` whether a frozen player's NPC may use credit.
const cr: any = config.credit && typeof config.credit === "object" ? config.credit : null;
export const CREDIT = cr ? {
  field: typeof cr.field === "string" && cr.field ? cr.field as string : "chips",
  empty: Number.isFinite(Number(cr.empty)) ? Number(cr.empty) : 0,
  gameOver: cr.game_over !== false, // false: a table down to one player with chips is not "over" (busted players stay; the game ends by wrap_up)
  start: Math.max(1, Math.floor(Number(cr.start)) || 200),
  // start_from: a game field (e.g. imeng.stack) whose number is the re-entry price/stack when the table set one; currency: the unit (default "chips"), recorded with each code and checked against a payment that names one;
  // require_terms: a payment must name the amount and the currency; max_credit: the most one /admin/credit call may add (default 100000).
  startFrom: typeof cr.start_from === "string" && /^(imeng|game)\.[\w-]+$/.test(cr.start_from) ? cr.start_from.replace(/^imeng\./, "game.") : "",
  currency: typeof cr.currency === "string" && cr.currency.trim() ? cr.currency.trim().slice(0, 12) : "chips",
  requireTerms: cr.require_terms === true,
  maxCredit: Math.max(1, Math.floor(Number(cr.max_credit)) || 100000),
  debtLimit: Math.max(0, Math.floor(Number(cr.debt_limit)) || 0),
  codeTtlMs: parseDurationMs(typeof cr.code_ttl === "string" ? cr.code_ttl : "7d") ?? 7 * 86_400_000,
  frozenBorrow: cr.frozen_borrow === true,
  // banking: /bank <amount> locks chips away (the NPC that takes a leaving player's seat cannot touch them). The least that can be banked is `min_antes` times the ante the
  // table registered (`ante`, a state path, default game.ante). When the table is down to one player the game is over and the ante goes back to what it started as.
  minAntes: Math.max(0, Number(cr.min_antes) >= 0 ? Math.floor(Number(cr.min_antes)) : 20),
  ante: typeof cr.ante === "string" && cr.ante ? (cr.ante as string).replace(/^imeng\./, "game.") : "game.ante",
  // reset: {"imeng.small_blind": "start", "imeng.hands_played": 0, "imeng.blind_base": null}: what else goes back when the game is over. "start" = the value the field had when the first hand began; a number, text or true/false is set as given; null removes it.
  reset: Object.fromEntries(Object.entries(cr.reset && typeof cr.reset === "object" && !Array.isArray(cr.reset) ? (cr.reset as Record<string, unknown>) : {}).filter(([k, v]) => /^(imeng|game)\.[\w-]+$/.test(k) && (v === null || ["string", "number", "boolean"].includes(typeof v))).map(([k, v]) => [k.replace(/^imeng\./, "game."), v])) as Record<string, string | number | boolean | null>,
} : null;
// hazards: dangers the server rolls after each round (a blizzard in Quebec, a hurricane in Florida, a rare earthquake on the Pacific rim). Each entry: `regions` (keys of imeng.region),
// `chance` (per round), `seasons` (multipliers by imeng.season), `text` (what the narrator dramatises), `set` (state changes: the move to the shelter). The chance is multiplied by the
// producer's modifier (imeng.hazard_mod, default 1; the owner sets it with /risk) and may be replaced by a function in `file` (a .mjs in the imeng folder exporting
// hazardChance({hazard, region, lat, lon, season, base, modifier, state})), so a place like the north pole can follow its own rules. `trigger`: roll (dice), producer (/shelter only) or both.
const hz: any = config.hazards && typeof config.hazards === "object" ? config.hazards : null;
export const HAZARDS = hz ? {
  trigger: (hz.trigger === "roll" || hz.trigger === "producer" ? hz.trigger : "both") as "roll" | "producer" | "both",
  phase: typeof hz.phase === "string" && hz.phase ? hz.phase as string : "playing",
  repeat: Math.min(1, Math.max(0, Number.isFinite(Number(hz.repeat)) && hz.repeat !== undefined ? Number(hz.repeat) : 0.1)),
  file: typeof hz.file === "string" && hz.file ? hz.file as string : "",
  shelter: { set: (hz.shelter?.set && typeof hz.shelter.set === "object" ? hz.shelter.set : {}) as Record<string, unknown>, text: typeof hz.shelter?.text === "string" ? hz.shelter.text as string : "The producer has called it: everyone is moved to the secure, heated shelter." },
  table: (Array.isArray(hz.table) ? hz.table : []).flatMap((h: any, i: number) => h && typeof h === "object" && typeof h.text === "string" && h.text && Number(h.chance) >= 0
    ? [{ id: typeof h.id === "string" && h.id ? h.id as string : `hazard${i + 1}`, regions: (Array.isArray(h.regions) ? h.regions : []).map(String), chance: Math.min(1, Number(h.chance)), seasons: (h.seasons && typeof h.seasons === "object" ? h.seasons : {}) as Record<string, number>, if: h.if && typeof h.if.field === "string" ? { field: h.if.field as string, is: String(h.if.is ?? "") } : undefined, text: h.text as string, set: (h.set && typeof h.set === "object" ? h.set : {}) as Record<string, unknown> }] : []),
} : null;
// producer: who may use the producer's commands (/risk, /shelter, /move, /end). who: "owner" (default) or "role" (anyone whose actor role is `role`, default "producer"); commands: per-command override.
const pr: any = config.producer && typeof config.producer === "object" ? config.producer : {};
const who = (v: unknown, d: string): "owner" | "role" => (v === "role" ? "role" : v === "owner" ? "owner" : (d as "owner"));
export const PRODUCER = { role: typeof pr.role === "string" && pr.role ? pr.role as string : "producer", who: who(pr.who, "owner"), nudge: pr.nudge === true, commands: Object.fromEntries(Object.entries(pr.commands && typeof pr.commands === "object" ? pr.commands : {}).map(([k, v]) => [k, who(v, "owner")])) as Record<string, "owner" | "role"> };
// audience: people who watch (actors with role `role`, default "audience") and what they do. reactions: "none" or "energy": each round the audience's messages add to game.audience_energy (0 to `max`), which falls by `decay` each round
// without them; the narrator sees the number as crowd mood. boost: with energy at or above `at`, quoted evidence of interest lifts attraction one step more than it would, never past level `cap` (default 2). seats: the roles the owner may assign with /seat.
const au: any = config.audience && typeof config.audience === "object" ? config.audience : null;
export const AUDIENCE = au ? {
  role: typeof au.role === "string" && au.role ? au.role as string : "audience",
  reactions: (au.reactions === "none" ? "none" : "energy") as "none" | "energy",
  max: Math.max(1, Math.floor(Number(au.max)) || 10), decay: Math.max(0, Number(au.decay) >= 0 ? Number(au.decay) : 1),
  boost: au.boost && typeof au.boost === "object" ? { at: Math.max(1, Number(au.boost.at) || 6), cap: Math.min(2, Math.max(1, Math.floor(Number(au.boost.cap)) || 2)) } : null,
  seats: (Array.isArray(au.seats) ? au.seats.map(String) : ["contestant", "audience", "host", "producer"]) as string[],
} : null;
// deal: "server" = the server deals the cards (poker-deal-turn.ts) and the narrator never does; "narrator" (default) = the narrator deals, as before. No silent fallback between the two.
export const DEAL: "server" | "narrator" = config.deal === "server" ? "server" : "narrator";
// shuffle: who may shuffle and whether a hand is blocked until someone does. required: "never" (default: the server shuffles by itself) or "each_hand" (the deal waits for game.shuffled = 1, set when the last
// ritual step is done); by: "dealer" (the owner, the house, or an actor with role dealer), "host" (owner or role host), "users" (anyone seated) or "nobody" (a /shuffle does nothing: magic decks); ritual: steps to run
// in order as /shuffle <step> (for example ["riffle 7", "cut"]); empty = a bare /shuffle. Code does the real randomising once the ritual is done: the ritual is only the gate.
const shf: any = config.shuffle && typeof config.shuffle === "object" ? config.shuffle : null;
export const SHUFFLE = shf ? {
  required: (shf.required === "each_hand" ? "each_hand" : "never") as "never" | "each_hand",
  by: (["dealer", "host", "users", "nobody"].includes(shf.by) ? shf.by : "dealer") as "dealer" | "host" | "users" | "nobody",
  ritual: (Array.isArray(shf.ritual) ? shf.ritual : []).map(String).filter(Boolean) as string[],
} : null;
// audit: what the house (the owner) may read about the cards after a round, privately with /audit: any of deck (the cards set aside for the board), draws (what was turned and when), shuffles (who ran which step),
// hands (every player's hole cards). Never shown to the table.
const adt: any = config.audit && typeof config.audit === "object" ? config.audit : null;
export const AUDIT = adt ? { shows: (Array.isArray(adt.shows) ? adt.shows.map(String) : ["deck", "draws", "shuffles"]).filter((x: string) => ["deck", "draws", "shuffles", "hands"].includes(x)) as string[] } : null;
// betting: "server" = code keeps the chips, bets, pot, turn order and showdown (poker-bet.ts) and players use /check /call /raise /fold /allin; "narrator" (default) = the narrator keeps them. No automatic fallback.
export const BETTING: "server" | "narrator" = config.betting === "server" ? "server" : "narrator";
// blinds: {steps: [1, 2, 3, 5, 10], every: 10}: betting "server" raises the blinds like a casino: after every `every` hands the server has dealt (default 10) the level goes up, and a level multiplies the blinds the table started with
// (game.small_blind / game.big_blind at the first hand, kept as game.blind_base). The last step stays. Off when absent or invalid.
const bl: any = config.blinds && typeof config.blinds === "object" ? config.blinds : null;
const blSteps = (Array.isArray(bl?.steps) ? bl.steps : []).map((x: unknown) => Number(x)).filter((x: number) => Number.isFinite(x) && x >= 1 && x <= 1000).slice(0, 40);
export const BLINDS: { steps: number[]; every: number } | null = blSteps.length ? { steps: blSteps, every: Math.max(1, Math.floor(Number(bl.every)) || 10) } : null;
// derive: {"imeng.<target>": {from: "imeng.<field>", map: {<value>: <result>}, default?}}: after every change the server sets a game field from another game field (ambient -> viscosity). The target is server-owned.
const dv: any = config.derive && typeof config.derive === "object" && !Array.isArray(config.derive) ? config.derive : {};
const gp = (s: unknown): string => String(s).replace(/^imeng\./, "game.");
export const DERIVE: { target: string; from: string; map: Record<string, string | number | boolean>; def: string | number | boolean }[] = Object.entries(dv)
  .filter(([t, d]: [string, any]) => /^(imeng|game)\.[\w-]+$/.test(t) && d && typeof d.from === "string" && /^(imeng|game)\.[\w-]+$/.test(d.from) && d.map && typeof d.map === "object" && !Array.isArray(d.map))
  .map(([t, d]: [string, any]) => ({ target: gp(t), from: gp(d.from), map: Object.fromEntries(Object.entries(d.map).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))) as Record<string, string | number | boolean>, def: ["string", "number", "boolean"].includes(typeof d.default) ? d.default : "" }));
// tips: a house tip jar (game.tips, chips only, never the pot). `/tip` puts one `amount` (a state path, e.g. imeng.big_blind) from the player's stack into it, any time. After `after_hands` hands
// (or the table's game.tip_after) with no tip, or when a seated player leaves (on_leave), the narrator is told to cough (texts.cough) and every seated real player is privately asked (texts.ask).
// npc_chance: the chance a winning NPC tips. Needs betting "server" for the hand count; off when absent.
const tp: any = config.tips && typeof config.tips === "object" ? config.tips : null;
const tipText = (k: string, d: string): string => (typeof tp?.texts?.[k] === "string" && tp.texts[k].trim() ? String(tp.texts[k]).slice(0, 400) : d);
export const TIPS: { amount: string; after: number; onLeave: boolean; npcChance: number; texts: { cough: string; ask: string; thanks: string; poor: string; npc: string } } | null = tp && typeof tp.amount === "string" && /^(imeng|game)\.[\w-]+$/.test(tp.amount)
  ? { amount: tp.amount.replace(/^imeng\./, "game."), after: Math.max(1, Math.min(100, Math.floor(Number(tp.after_hands)) || 3)), onLeave: tp.on_leave !== false, npcChance: Math.min(1, Math.max(0, Number(tp.npc_chance) || 0)),
      texts: { cough: tipText("cough", "The Dealer coughs pointedly, once: a tip in the house jar would be welcome. One line, in character; do not ask anyone by name, do not press, and never mention a command or an amount."), ask: tipText("ask", "Do you want to tip the dealer? Type /tip in the table chat: it puts {amount} chips in the house jar."), thanks: tipText("thanks", "{name} tips the dealer {amount}. The jar holds {total}."), poor: tipText("poor", "You do not have chips to spare for a tip."), npc: tipText("npc", "{name} tips the dealer {amount}.") } }
  : null;
// pay: {field, phases, texts}: `/pay <name> <amount>` moves a whole number of `field` (an actor number, default chips) from the sender to another seated real player, in code.
// phases (default: any) lists the game phases it is allowed in. Off when absent. Chips only; the narrator cannot move them.
const py: any = config.pay && typeof config.pay === "object" ? config.pay : null;
const pyText = (k: string, d: string): string => (typeof py?.texts?.[k] === "string" && py.texts[k].trim() ? String(py.texts[k]).slice(0, 300) : d);
export const PAY: { field: string; phases: string[]; escrow: { releaseOn: string[] } | null; texts: Record<"paid" | "usage" | "who" | "self" | "poor" | "phase" | "seat" | "held" | "released" | "refunded" | "no_escrow" | "refund_late", string> } | null = py
  ? { escrow: py.escrow ? { releaseOn: (Array.isArray(py.escrow.release_on) ? py.escrow.release_on : []).filter((x: unknown): x is string => typeof x === "string") } : null, field: typeof py.field === "string" && /^[\w-]{1,40}$/.test(py.field) ? py.field : "chips", phases: (Array.isArray(py.phases) ? py.phases : []).filter((x: unknown): x is string => typeof x === "string"),
      texts: { paid: pyText("paid", "{from} pays {to} {amount}."), usage: pyText("usage", "Say /pay <name> <amount>."), who: pyText("who", "There is nobody called \"{who}\" at this table."), self: pyText("self", "You cannot pay yourself."), poor: pyText("poor", "You do not have that much."), phase: pyText("phase", "Payments are not allowed right now."), seat: pyText("seat", "You are not seated at this table."), held: pyText("held", "{from} puts {amount} in escrow for {to}. Say /pay release to pay it, or /pay refund to take it back before it starts."), released: pyText("released", "{from} releases {amount} to {to}."), refunded: pyText("refunded", "{from} takes {amount} back from escrow."), no_escrow: pyText("no_escrow", "You have nothing in escrow."), refund_late: pyText("refund_late", "It is too late to take it back.") } }
  : null;
// seating: gated seats. People who speak without a seat are not players; `/seat <age> <gender> [sexuality]` then `/seat yes` (opt-in) takes one, only in `phases` (default between hands); a yes sent
// during a hand is queued and seated when the phase allows. Age is at least 18 whatever config.json says, and at least min_age and game.min_age (the owner's). Needs a multiplayer table. Off when absent.
const sg: any = config.seating && typeof config.seating === "object" ? config.seating : null;
const sgText = (k: string, d: string): string => (typeof sg?.texts?.[k] === "string" && sg.texts[k].trim() ? String(sg.texts[k]).slice(0, 500) : d);
const sgList = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && /^[\p{L} -]{1,30}$/u.test(x.trim())).map((x) => x.trim().toLowerCase());
const sgField = (v: unknown, d: string): string => (typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : d);
// vision: the host-only Python worker for the seat pose check and the image censor (src/tools/vision/worker.py): {python, venv, script, device, idle_stop_s, timeout_s, pose_weights, url}. `${NAME}` placeholders are filled from the environment (like images.process).
// Outside production the worker is stopped after idle_stop_s idle seconds so a GPU is returned; with `url` the same JSON goes over HTTP to a worker someone else runs. Off when absent.
const vs: any = config.vision && typeof config.vision === "object" ? config.vision : null;
export const VISION: { python: string; venv: string; script: string; device: "cpu" | "cuda"; idleStopS: number; timeoutS: number; poseWeights: string; url: string } | null = vs ? {
  python: typeof vs.python === "string" && vs.python.trim() ? vs.python.trim() : "python3", venv: typeof vs.venv === "string" ? vs.venv : "", script: typeof vs.script === "string" && vs.script.trim() ? vs.script.trim() : "src/tools/vision/worker.py",
  device: vs.device === "cuda" ? "cuda" : "cpu", idleStopS: Number.isFinite(Number(vs.idle_stop_s)) ? Math.max(0, Math.min(86400, Number(vs.idle_stop_s))) : (["NODE_ENV", "ENV"].some((k) => (process.env[k] ?? "").toLowerCase() === "production") ? 0 : 120),
  timeoutS: Math.max(5, Math.min(600, Number(vs.timeout_s) || 60)), poseWeights: typeof vs.pose_weights === "string" ? vs.pose_weights : "", url: typeof vs.url === "string" ? vs.url.trim() : "" } : null;
// terms: {file, notice, remember_days}: a markdown file in the imeng folder sent privately, once per person and game, when they are seated (or join, or start a solo game). `notice` is the line the table sees. Off when absent.
const tm: any = config.terms && typeof config.terms === "object" ? config.terms : null;
export const TERMS: { file: string; notice: string; rememberDays: number } | null = tm && typeof tm.file === "string" && tm.file.trim()
  ? { file: tm.file.trim(), notice: typeof tm.notice === "string" && tm.notice.trim() ? tm.notice.trim().slice(0, 300) : "The terms are in your private messages.", rememberDays: Math.max(1, Math.min(3650, Math.floor(Number(tm.remember_days)) || 365)) } : null;
export interface SeatPhotoCfg { required: boolean; textFile: string; keepHours: number; show: boolean; check: { url: string; threshold: number; keypoint: number; people: number; eyes: number; faceMin: number }; texts: Record<"rules" | "accepted" | "format" | "unsafe" | "down" | "none" | "many" | "unclear" | "wait" | "shown", string> }
const spn = (v: unknown, d: number, lo: number, hi: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(hi, Math.max(lo, Number(v))) : d);
const spt = (o: any, k: string, d: string): string => (typeof o?.[k] === "string" && o[k].trim() ? String(o[k]).slice(0, 1200) : d);
const sph: any = sg?.photo && typeof sg.photo === "object" ? sg.photo : null;
const SEAT_PHOTO: SeatPhotoCfg | null = sph ? {
  required: sph.required !== false, textFile: typeof sph.text_file === "string" ? sph.text_file : "", keepHours: Math.floor(spn(sph.keep_hours, 24, 1, 720)), show: sph.show !== false,
  check: { url: typeof sph.check?.url === "string" ? sph.check.url : "", threshold: spn(sph.check?.threshold, 0.4, 0.05, 0.99), keypoint: spn(sph.check?.keypoint, 0.5, 0.05, 0.99), people: Math.floor(spn(sph.check?.people, 1, 1, 5)), eyes: sph.check?.eyes === undefined ? 0 : spn(sph.check.eyes, 0, 0.05, 0.99), faceMin: sph.check?.face_min === undefined ? 0 : spn(sph.check.face_min, 0, 0.05, 0.99) },
  texts: {
    rules: spt(sph.texts, "rules", "To take a seat, send one picture of yourself: safe for work, and only you in it (nobody else). Either your face (your nose must show; covering your eyes or your mouth is fine) or your body from chin to thighs. When the show starts the table sees it, and by sending it you agree to that. It is deleted {hours} hours after you send it. Attach it to a message."),
    accepted: spt(sph.texts, "accepted", "Picture accepted ({kind})."), format: spt(sph.texts, "format", "I can only read PNG, JPEG or WebP pictures."), unsafe: spt(sph.texts, "unsafe", "That picture is not safe for work. Send another."),
    down: spt(sph.texts, "down", "I cannot check pictures right now, so no seat can be taken yet. Try again later."), none: spt(sph.texts, "none", "I cannot see a person in that picture. Send one of just you."),
    many: spt(sph.texts, "many", "There is more than one person in that picture. Send one of just you."), unclear: spt(sph.texts, "unclear", "I cannot tell: show your face (your nose must show) or your body from chin to thighs."),
    wait: spt(sph.texts, "wait", "Your seat waits for a picture. Attach it to a message."), shown: spt(sph.texts, "shown", "The show starts. Here are the contestants:"),
  } } : null;
const sst: any = sg?.start && typeof sg.start === "object" ? sg.start : null;
export const SEATING: { photo: SeatPhotoCfg | null; start: { auto: boolean; early: boolean; texts: Record<"started" | "already" | "few" | "not_owner" | "off", string> } | null; approval: "owner" | "none"; phases: string[]; minAge: number; fields: { age: string; gender: string; sexuality: string }; genders: string[]; sexualities: string[]; defaultSexuality: string; texts: Record<"usage" | "confirm" | "seated" | "queued" | "already" | "age" | "gender" | "sexuality" | "none" | "full" | "unseated" | "game" | "nothing" | "welcome" | "waiting" | "request" | "approved" | "denied" | "refused" | "not_owner" | "no_request" | "no_owner", string> } | null = sg
  ? { photo: SEAT_PHOTO, start: sst ? { auto: sst.auto !== false, early: sst.early !== false, texts: { started: spt(sst.texts, "started", "The show is starting."), already: spt(sst.texts, "already", "The show has already started."), few: spt(sst.texts, "few", "Not enough seats are taken yet ({have} of {need})."), not_owner: spt(sst.texts, "not_owner", "Only the table owner can start the show."), off: spt(sst.texts, "off", "There is nothing to start here.") } } : null, approval: sg.approval === "owner" ? "owner" as const : "none" as const, phases: (Array.isArray(sg.phases) ? sg.phases : ["between"]).filter((x: unknown): x is string => typeof x === "string"), minAge: Math.max(18, Math.min(120, Math.floor(Number(sg.min_age)) || 18)),
      fields: { age: sgField(sg.fields?.age, "age"), gender: sgField(sg.fields?.gender, "gender"), sexuality: sgField(sg.fields?.sexuality, "sexuality") },
      genders: sgList(sg.genders), sexualities: sgList(sg.sexualities), defaultSexuality: typeof sg.default_sexuality === "string" ? sg.default_sexuality.trim().toLowerCase().slice(0, 30) : "",
      texts: { usage: sgText("usage", "To take a seat say /seat <age> <gender> <sexuality> (sexuality is optional)."), confirm: sgText("confirm", "You are asking for a seat: age {age}, {gender}, {sexuality}. Seats are for consenting adults ({min} or older) who are here by choice and may leave at any time. Say /seat yes to confirm."),
        seated: sgText("seated", "{name} has a seat."), queued: sgText("queued", "A hand is being played. You are noted, and will be seated when it is over."), already: sgText("already", "You already have a seat."), age: sgText("age", "Seats are for adults: {min} or older."),
        gender: sgText("gender", "Say one of: {list}."), sexuality: sgText("sexuality", "Say one of: {list}."), none: sgText("none", "Say /seat <age> <gender> <sexuality> first."), full: sgText("full", "This table is full."),
        unseated: sgText("unseated", "You are watching. Take a seat with /seat <age> <gender> <sexuality> to play."), game: sgText("game", "There is no game here yet."), nothing: sgText("nothing", "You have no seat to give up."), welcome: sgText("welcome", "You now have a seat at the table."),
        waiting: sgText("waiting", "Your request is with the table owner. You will be told."), request: sgText("request", "{name} asks for a seat: age {age}, {gender}, {sexuality}. Say /seat approve {name} or /seat deny {name}."),
        approved: sgText("approved", "{name} is approved for a seat."), denied: sgText("denied", "{name} will not be seated."), refused: sgText("refused", "The table owner did not approve your request for a seat."),
        not_owner: sgText("not_owner", "Only the table owner can do that."), no_request: sgText("no_request", "Nobody called {name} is waiting for a seat."), no_owner: sgText("no_owner", "There is no table owner to approve seats yet.") } }
  : null;
// sense: {margin, window, samples, bluff_below, texts: {against, caught}}: betting "server" weighs every play against the odds (win chance by sampling) and remembers who played against them and who was caught raising weak at a showdown. Off when absent.
const sn: any = config.sense && typeof config.sense === "object" ? config.sense : null;
const snText = (k: string, d: string): string => (typeof sn?.texts?.[k] === "string" && sn.texts[k].trim() ? String(sn.texts[k]).slice(0, 300) : d);
export const SENSE: { margin: number; window: number; samples: number; bluffBelow: number; texts: { against: string; caught: string } } | null = sn
  ? { margin: Math.min(0.5, Math.max(0, Number(sn.margin) || 0.15)), window: Math.max(5, Math.min(100, Math.floor(Number(sn.window)) || 20)), samples: Math.max(20, Math.min(2000, Math.floor(Number(sn.samples)) || 200)), bluffBelow: Math.min(0.6, Math.max(0, Number(sn.bluff_below) || 0.3)),
      texts: { against: snText("against", "{name} has played against the odds in {bad} of the last {n} decisions: they are guessing, or playing something else. Colour only; say it in the story if it fits."), caught: snText("caught", "{name} has been caught bluffing at {n} showdowns: the table has seen it.") } }
  : null;
// private_hands: {field}: the actor field that holds a player's private cards. `/hand` shows a player their own cards, only in their private chat; in the shared chat it points them there.
export const HANDS = config.private_hands && typeof config.private_hands === "object" ? { field: typeof (config.private_hands as any).field === "string" && (config.private_hands as any).field ? (config.private_hands as any).field as string : "hole" } : null;
// random_events: events the server rolls after each round. `chance` 0 to 1, `if` a condition, `set` state changes, `text` what the narrator dramatises, `once` (default true) one time per game.
export const RANDOM_EVENTS: { id: string; chance: number; if?: unknown; set: Record<string, unknown>; text: string; once: boolean }[] = (Array.isArray(config.random_events) ? config.random_events : []).flatMap((e: any, i: number) =>
  e && typeof e === "object" && Number(e.chance) > 0 && typeof e.text === "string" && e.text ? [{ id: typeof e.id === "string" && e.id ? e.id : `rand${i + 1}`, chance: Math.min(1, Number(e.chance)), if: e.if, set: e.set && typeof e.set === "object" ? e.set as Record<string, unknown> : {}, text: e.text as string, once: e.once !== false }] : []);
// forfeit: {chance, if, rounds, text, done, missed, penalty: {field, add}}: after a narrated round the server may deal one real player (meeting `if`, a per-actor condition) a forfeit: send a picture within `rounds` narrated rounds ({name} in the texts).
// A miss applies `penalty` (an actor number field, add may be negative). Off when absent.
const fo: any = config.forfeit && typeof config.forfeit === "object" ? config.forfeit : null;
const foPen: any = fo?.penalty && typeof fo.penalty === "object" && typeof fo.penalty.field === "string" && /^[\w-]+$/.test(fo.penalty.field) && Number.isFinite(Number(fo.penalty.add)) ? fo.penalty : null;
export const FORFEIT: { chance: number; if?: unknown; rounds: number; text: string; done: string; missed: string; penalty: { field: string; add: number } | null } | null = fo && Number(fo.chance) > 0 && typeof fo.text === "string" && fo.text
  ? { chance: Math.min(1, Number(fo.chance)), if: fo.if, rounds: Math.max(1, Math.min(20, Math.floor(Number(fo.rounds)) || 2)), text: fo.text, done: typeof fo.done === "string" && fo.done ? fo.done : "{name} sent it.", missed: typeof fo.missed === "string" && fo.missed ? fo.missed : "{name} did not send it in time.", penalty: foPen ? { field: foPen.field, add: Number(foPen.add) } : null } : null;
// ban: an actor whose `flag_field` is set true by the narrator (the player looked at another's cards) is put out of the table for `hours` (default 12): their messages are not read, the deal skips them,
// their private channel is ignored. `text` is what they are told ({time} is when it ends).
const bn: any = config.ban && typeof config.ban === "object" ? config.ban : null;
export const BAN = bn ? {
  hours: Number(bn.hours) > 0 ? Number(bn.hours) : 12,
  wrongGuessHours: Number(bn.wrong_guess_hours) > 0 ? Number(bn.wrong_guess_hours) : 24,
  revealHours: Number(bn.reveal_hours) > 0 ? Number(bn.reveal_hours) : 168,
  peekPhases: (Array.isArray(bn.peek_phases) ? bn.peek_phases.map(String) : ["preflop"]) as string[],
  flag: typeof bn.flag_field === "string" && bn.flag_field ? bn.flag_field as string : "caught",
  text: typeof bn.text === "string" && bn.text ? bn.text as string : "You were caught looking at someone else's cards, so you are out of the game until {time}. You can stay on the call and listen, but you cannot play, and the table will not hear you.",
} : null;
// ruling: in `phase` a small judge says which spell or item the player attempts and whether the character could; `table` (class -> spells) is code and wins over the judge. Works for a table too: each public line of the round is ruled on in turn.
const rl: any = config.ruling && typeof config.ruling === "object" && typeof (config.ruling as any).phase === "string" ? config.ruling : null;
export const RULING = rl ? {
  phase: rl.phase as string,
  field: typeof rl.class_field === "string" && rl.class_field ? rl.class_field as string : "class",
  question: typeof rl.question === "string" ? rl.question as string : "",
  suits: (rl.suits && typeof rl.suits === "object" ? Object.fromEntries(Object.entries(rl.suits).filter(([, v]) => typeof v === "string").map(([k, v]) => [String(k).toLowerCase(), String(v).toLowerCase()])) : {}) as Record<string, string>,
  classSuits: (rl.class_suits && typeof rl.class_suits === "object" ? Object.fromEntries(Object.entries(rl.class_suits).map(([k, v]: [string, any]) => [String(k).toLowerCase(), { aligned: (Array.isArray(v?.aligned) ? v.aligned : []).filter((x: unknown): x is string => typeof x === "string"), opposed: (Array.isArray(v?.opposed) ? v.opposed : []).filter((x: unknown): x is string => typeof x === "string") }])) : {}) as Record<string, { aligned: string[]; opposed: string[] }>,
  table: rl.table && typeof rl.table === "object" ? Object.fromEntries(Object.entries(rl.table).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")])) as Record<string, string[]> : undefined,
} : null;
// voices: every NPC contestant gets a small call of their own for what they say next (in parallel, before the narrator), handed to the narrator as their dialogue.
const vc: any = config.voices && typeof config.voices === "object" ? config.voices : null;
export const VOICES = vc ? {
  roles: (Array.isArray(vc.roles) ? vc.roles : []).filter((r: unknown): r is string => typeof r === "string"),
  roleField: typeof vc.role_field === "string" ? vc.role_field as string : "",
  skip: (Array.isArray(vc.skip) ? vc.skip : ["table"]).filter((r: unknown): r is string => typeof r === "string"),
  max: Number.isFinite(Number(vc.max)) ? Math.min(10, Math.max(1, Math.floor(Number(vc.max)))) : 4,
  words: Number.isFinite(Number(vc.words)) ? Math.min(100, Math.max(5, Math.floor(Number(vc.words)))) : 30,
  feelings: vc.feelings && typeof vc.feelings === "object" ? (() => { const f: any = vc.feelings, t = (v: unknown, x: string): string => (typeof v === "string" && v.trim() ? v.slice(0, 300) : x); return { warmAt: Math.min(3, Math.max(1, Math.floor(Number(f.warm_at)) || 2)), warm: t(f.warm, "{name} is drawn to {to}: let it show a little, a glance, a lingering word, never a declaration."), cold: t(f.cold, "{name} cannot stand {to}: a cool remark or a pointed silence is in character, mild and playful, never cruel.") }; })() : null,
  judge: vc.judge && typeof vc.judge === "object" ? vc.judge : undefined,
} : null;
// naming: characters that arrive without a name (an NPC contestant) are named by a separate small call and checked by code (unused, not alike in sound or first letters to a used name). `prompt` has {used}.
// `roles` limits it to actors whose `role_field` is one of them (default: every NPC); `skip` lists actor ids that keep no name (a table, a narrator).
const nm: any = config.naming && typeof config.naming === "object" ? config.naming : null;
export const NAMING = nm ? {
  pool: Number.isFinite(Number(nm.pool)) ? Math.min(10, Math.max(0, Math.floor(Number(nm.pool)))) : 3,
  prompt: typeof nm.prompt === "string" && nm.prompt ? nm.prompt as string : undefined as unknown as string,
  role: typeof nm.role_field === "string" ? nm.role_field as string : "role",
  roles: (Array.isArray(nm.roles) ? nm.roles : []).filter((r: unknown): r is string => typeof r === "string"),
  skip: (Array.isArray(nm.skip) ? nm.skip : ["table"]).filter((r: unknown): r is string => typeof r === "string"),
} : null;
// write_once: actor fields that, once an op has set them, can never be changed again ("no breakups on live TV"). The lock is kept in game.locked (server-owned).
export const WRITE_ONCE: string[] = (Array.isArray(config.write_once) ? config.write_once : []).filter((f: unknown): f is string => typeof f === "string" && safeSeg(f));
// show_clock: a TV-format clock in minutes, kept in game.show_minutes (server-owned). Each round costs `costs[<phase the round was played in>]` minutes (else `per_round`, default 1), whatever the real clock says,
// so an hour of silence costs nothing. From the first `warn_at` mark the narrator is told how long is left; at `total` the next reply is the finale (see wrap_up).
const sc: any = config.show_clock && typeof config.show_clock === "object" ? config.show_clock : null;
export const SHOW_CLOCK = sc && Number(sc.total) > 0 ? {
  total: Number(sc.total),
  perRound: Number.isFinite(Number(sc.per_round)) ? Math.max(0, Number(sc.per_round)) : 1,
  costs: Object.fromEntries(Object.entries(sc.costs && typeof sc.costs === "object" ? sc.costs : {}).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) as Record<string, number>,
  judge: sc.judge === true,
  jumpMax: Number(sc.jump_max) > 0 ? Number(sc.jump_max) : 10,
  warnAt: (Array.isArray(sc.warn_at) ? sc.warn_at : []).map(Number).filter((n: number) => n > 0).sort((a: number, b: number) => a - b) as number[],
} : null;
// wrap_up: the escape hatch when the prompt is still near the limit after compaction
const wrap = config.wrap_up ?? {};
export const WRAP_UP = SHOW_CLOCK || Number(wrap.at_tokens) > 0 || Number(wrap.at_turn) > 0 || CONTEXT_MAX_ROUNDS > 0 || TURN_EVENTS.some((e) => e.end)
  ? {
      at_tokens: Number(wrap.at_tokens) > 0 ? Number(wrap.at_tokens) : 0,
      // a turn budget (a measured number of player turns the hardware can carry): the server closes the game on that turn
      at_turn: Number(wrap.at_turn) > 0 ? Math.floor(Number(wrap.at_turn)) : 0,
      // heads-up: for this many turns before at_turn the narrator is told the end is near, so the story can wind down
      soon_turns: Number(wrap.soon_turns) > 0 ? Math.floor(Number(wrap.soon_turns)) : 0,
      soon_text: wrap.soon_text || "The game is nearly over. Over the next few replies steer the story toward a natural close: resolve open threads and do not start anything long. Do not announce the end yet.",
      text: wrap.text || "The conversation has run out of room. In this reply, bring the game to a natural, warm close in the style of the game: wrap up the story, thank the player, and do not start anything new.",
      on_exit: wrap.on_exit === "user" || wrap.on_exit === "all" ? wrap.on_exit : null,
      over_reply: typeof wrap.over_reply === "string" ? wrap.over_reply : "",
      // a fixed file (in the game folder) added word for word after the narrator's finale: credits, a licence line, a thank-you
      credits: typeof wrap.credits_file === "string" && wrap.credits_file && !path.isAbsolute(wrap.credits_file) && !wrap.credits_file.split(/[\\/]/).includes("..") ? (readOptional(wrap.credits_file) ?? "").trim() : "",
      // hard: at_turn counts rounds whatever compaction does. after_compaction: at_turn (and soon_turns) are skipped once a recap exists
      turn_budget: wrap.turn_budget === "after_compaction" ? "after_compaction" as const : "hard" as const,
      after_text: wrap.after_text || "The game is over. Do not start anything new or ask for more input; answer any further message briefly, in keeping with the game, and say the session has ended and a new one can be started.",
    }
  : null;
// tail_notices (default false): server notices go at the end of the last player message
export const TAIL_NOTICES = config.tail_notices === true;
// enforce_rules (default false): the judge audits each reply against the active session rules
export const ENFORCE_RULES = config.enforce_rules === true;
export const JUDGE_LOGGING = !["0", "false", "off"].includes((process.env.JUDGE_LOGGING ?? "0").toLowerCase());
export const AUDIT_WITH_MAIN = config.rule_audit_with === "main";
// Session rules: {id, text, locked?, lift_hint?}
// world: {era, time_travel, canon: {name, file}, anachronism}: where and when the story is set. era: ancient | medieval | industrial | 1900s | 1990s | modern | near_future | far_future | custom (custom needs a canon file).
// time_travel: period (default: a traveller takes on the period, no items or knowledge from elsewhere) | keep (they keep their own) | none (there is none). canon: a markdown file in the imeng folder, shown to the narrator as the reference
// when the model may not know the setting. languages: {list, field} (the tongues that exist; an actor's `field`, default `languages`, lists those they understand). universe: {name, jump: none | allowed}. anachronism: block (default: a locked session rule the audit judge enforces; needs enforce_rules) | warn (the narrator reacts in character, no correction) | allow. Off when absent.
const ERAS = ["ancient", "medieval", "industrial", "1900s", "1990s", "modern", "near_future", "far_future", "custom"] as const;
const wd: any = config.world && typeof config.world === "object" ? config.world : null;
const canonFile = typeof wd?.canon?.file === "string" ? wd.canon.file : "";
const canonText = ((): string => { if (!canonFile) return ""; try { const p = path.resolve(IMENG_PATH, canonFile); if (!p.startsWith(path.resolve(IMENG_PATH) + path.sep)) return ""; return fs.readFileSync(p, "utf8").slice(0, 8000); } catch { return ""; } })();
const strList = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 40)).slice(0, n) : []);
const ud: any = wd?.universe && typeof wd.universe === "object" ? wd.universe : null;
export const WORLD: { era: (typeof ERAS)[number]; timeTravel: "period" | "keep" | "none"; anachronism: "block" | "warn" | "allow"; canonName: string; canon: string; languages: string[]; languageField: string; universe: string; universeJump: "none" | "allowed" } | null = wd && (ERAS as readonly string[]).includes(wd.era)
  ? { era: wd.era, timeTravel: ["keep", "none"].includes(wd.time_travel) ? wd.time_travel : "period", anachronism: ["warn", "allow"].includes(wd.anachronism) ? wd.anachronism : "block", canonName: typeof wd.canon?.name === "string" ? wd.canon.name.slice(0, 80) : "", canon: canonText,
    languages: strList(wd.languages?.list, 12), languageField: typeof wd.languages?.field === "string" && wd.languages.field ? wd.languages.field : "languages",
    universe: typeof ud?.name === "string" ? ud.name.trim().slice(0, 80) : "", universeJump: ud?.jump === "allowed" ? "allowed" : "none" }
  : null;
export const WORLD_ERA_RULE = "world_era";
const eraLabel = (e: string): string => e.replace(/_/g, " ");
export const WORLD_RULE_TEXT = WORLD ? `Everything in the story fits the era (${eraLabel(WORLD.era)}${WORLD.canonName ? `, as in ${WORLD.canonName}` : ""}): no object, technology, word or piece of knowledge that does not exist in that era, unless the world's own rules allow it.` : "";
export const SESSION_RULES = [...(config.session_rules || []), ...(WORLD && WORLD.anachronism === "block" ? [{ id: WORLD_ERA_RULE, text: WORLD_RULE_TEXT, locked: true }] : [])];
// dice: true = the default pool; an object = a custom pool ({"d20": 4, "d6": 10}); false/absent = off
export const DEFAULT_DICE_POOL: Record<string, number> = { d20: 8, d12: 3, d10: 3, d8: 4, d6: 8, d4: 4, d100: 2 };
export const DICE_POOL: Record<string, number> | null =
  config.dice === true ? DEFAULT_DICE_POOL
  : config.dice && typeof config.dice === "object" ? config.dice
  : null;
export const DICE = DICE_POOL !== null; // server pre-rolls dice for the narrator
// Actor ids: the person typing, and the prefix for generated NPC ids
export const USER_ID = config.user_id || "user";
export const NPC_PREFIX = config.npc_prefix || "npc_";
// Optional allowlist of actor fields the model may change (default: any except server-owned fields)
export const WRITABLE_FIELDS: Set<string> | null = Array.isArray(config.writable_fields) ? new Set(config.writable_fields) : null;
// Limits on what one model answer may do to the state
export const MAX_OPS = 50;           // ops accepted per answer
export const MAX_VALUE_CHARS = 1000; // serialized size of any value an op writes
// Languages and wording: the trigger sentence detector, extra placeholder patterns, prompt replacements
const compile = (src: string, what: string): RegExp => {
  try { return new RegExp(src, "iu"); }
  catch (e) { console.error(`Bad ${what} in config.json: ${(e as Error).message}`); process.exit(1); }
};
export const TRIGGER_RE = config.trigger_pattern
  ? compile(config.trigger_pattern, "trigger_pattern")
  : /\b(?:if|when|whenever)\b[^.\n]{0,120}\bmessage\b/i;
export const PLACEHOLDER_RES: RegExp[] = (config.placeholder_patterns || []).map((p) => compile(p, "placeholder_patterns"));
export const PROMPTS = config.prompts || {};
/** The imeng's own op checks (config.json `validate`), loaded once. */
export const VALIDATOR = await loadValidator(IMENG_PATH, config.validate).catch((e: Error) => { console.error(`config.json: ${e.message}`); process.exit(1); });
/** Whether a refused op gets one correction from the judge. */
export const REPAIR = config.repair ?? !!config.validate;
// invocation: "judge" decides from the first message whether the prompt applies; "always" skips the check
export const INVOCATION = config.invocation || "judge";
export const SETUP_TURNS = config.setup_turns ?? 3;
export const SETUP_HINT = config.setup_hint || "";

// Judge model + optional dedicated Ollama instance: {"port","num_ctx","gpu","models_dir"}
export const JUDGE_MODEL = process.env.JUDGE_MODEL || config.judge_model || MODEL;
export const JUDGE_CONFIRMATIONS = config.judge_confirmations ?? 2;
export const JUDGE_INSTANCE = process.env.JUDGE_INSTANCE === "off" ? null : config.judge_instance || null;
// JUDGE_URL: native Ollama API base of a judge Ollama that is already running elsewhere (e.g. on the
// Docker host, started with `npm run judge`). Used instead of the spawned instance, e.g. in Docker.
export const JUDGE_URL = (process.env.JUDGE_URL || "").replace(/\/+$/, "");
// judge_api: "ollama" (native /api/chat, the default) or "openai" (/v1/chat/completions, e.g. llama.cpp's llama-server). JUDGE_API_KEY is sent as a bearer token.
export const JUDGE_API: "ollama" | "openai" = process.env.JUDGE_API === "openai" || process.env.JUDGE_API === "ollama" ? process.env.JUDGE_API : config.judge_api === "openai" ? "openai" : "ollama";
export const JUDGE_API_KEY = process.env.JUDGE_API_KEY || "";
// Read from config.json even when spawning is off, so a remote judge uses the same context size.
export const JUDGE_NUM_CTX = config.judge_instance?.num_ctx || config.judge_num_ctx || 8192;
// What the judges see of an actor / of the plot: only fields that carry story meaning, not stats.
export const JUDGE_ACTOR_FIELDS = config.judge_actor_fields || ["name", "controlled_by", "relationship", "description", "statuses", "history"];
export const JUDGE_HISTORY_ITEMS = config.judge_history_items ?? 5; // recent history entries per actor
export const JUDGE_EVENTS = config.judge_events ?? 10;              // recent plot events

// Response log (Redis stream, with a file fallback)
export const REDIS_URL = process.env.REDIS_URL || "";
export const LOG_STREAM = process.env.LOG_STREAM || "game:model-responses";
export const LOG_MAXLEN = Number(process.env.LOG_MAXLEN || 100000);
export const LOG_PROMPT_CHARS = Number(process.env.LOG_PROMPT_CHARS || 20000);
export const LOG_FILE = path.resolve(process.env.LOG_FILE || "./logs/model-responses.jsonl");

// multiplayer (default off): several real people, one game. The table is a chat shared with Open WebUI's "Allow replies" (or a channel). See docs/MULTIPLAYER.md.
//   turns: how a round starts. ready = collect what everybody says, narrate when all said "ready" (default); free = every message is a round;
//     token = only the holder of token_field acts (off_turn says what happens to the others); judged = the judge model decides from turn_rule.
//   order: how several players' lines in one round are sequenced: fifo (arrival, default), filo (latest first), join, random, or {by: <actor field>, desc}.
//   clock: {field: "game.<field>", unit}: the in-game clock (second|minute|hour|day|week, or count for a plain counter) that in-game timeouts use.
//   tension: while the table waits on someone, mode "status" (default) answers with a terse line; "beats" has the narrator write one short in-story line that
//     keeps the waiting player's declared action in suspension (an extra short narrator call per message; cooldown_seconds spaces them out).
//   private: a player's own chat with the game is a private channel to the narrator (reply: ack | narrator | none; narrator_sees: the notes go into the next round).
//     false turns private chats off. seat_days: how long a seat at the table keeps a person's new chats private. leave_pattern: a whole message that leaves the table.
//   standing: where "if I do not answer in 5 days, assume ..." instructions are accepted: private chats only (default) or any chat.
//   default_after / default_action: what happens to a player the game waits on after that long (real and/or in-game time), if they left no standing instruction.
//   judge: use the judge model to read messages (turn policy judged, pause/return, standing instructions).
const mpRaw: any = config.multiplayer;
const DEFAULT_CONFIRM = "^(ready|confirm|confirmed|done|go)[\\s.!]*$";
const DEFAULT_LEAVE = "^\\s*(leave|quit)( the)? (table|game)[\\s.!]*$";
const regexOf = (src: unknown, dflt: string, name: string): RegExp => {
  try { return new RegExp(typeof src === "string" && src ? src : dflt, "i"); }
  catch { warn(`multiplayer.${name} is not a valid regular expression: ${String(src)}; using the default`); return new RegExp(dflt, "i"); }
};
export type MpOrder = "fifo" | "filo" | "join" | "random" | { by: string; desc: boolean };
const orderOf = (o: any): MpOrder => (["fifo", "filo", "join", "random"].includes(o) ? o : o && typeof o === "object" && typeof o.by === "string" && o.by ? { by: o.by, desc: o.desc !== false } : "fifo");
const clockOf = (c: any): { field: string; unit: ClockUnit } | null => {
  if (!c || typeof c !== "object" || typeof c.field !== "string" || !/^game\.[^.\s]+$/.test(c.field)) return null;
  return { field: c.field, unit: CLOCK_UNITS.includes(c.unit) ? c.unit : "count" };
};
const num = (v: unknown, dflt: number, min: number, max: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const privOf = (p: any): { reply: "ack" | "narrator" | "none"; narratorSees: boolean; maxWords: number; unseated: "ignore" | "seat"; forget: boolean } | null => {
  if (p === false) return null;
  const o = p && typeof p === "object" ? p : {};
  return { reply: o.reply === "narrator" || o.reply === "none" ? o.reply : "ack", narratorSees: o.narrator_sees !== false, maxWords: Math.floor(num(o.max_words, 60, 10, 300)), unseated: o.unseated === "seat" ? "seat" : "ignore", forget: o.forget === true };
};
export const MULTIPLAYER = mpRaw && mpRaw.enabled === true ? (() => {
  const clock = clockOf(mpRaw.clock);
  const after = mpRaw.default_after && typeof mpRaw.default_after === "object" ? mpRaw.default_after : null;
  const realMs = after ? parseDurationMs(after.real) : null;
  const game = after && clock ? parseGameDuration(after.game, clock.unit) : null;
  const t: any = mpRaw.tension && typeof mpRaw.tension === "object" ? mpRaw.tension : {};
  return {
    turns: (mpRaw.gate === false ? "free" : ["ready", "free", "token", "judged"].includes(mpRaw.turns as string) ? mpRaw.turns : "ready") as "ready" | "free" | "token" | "judged",
    tokenField: typeof mpRaw.token_field === "string" && /^game\.[^.\s]+$/.test(mpRaw.token_field) ? mpRaw.token_field : "game.current_actor",
    offTurn: (mpRaw.off_turn === "queue" ? "queue" : "note") as "queue" | "note",
    turnRule: typeof mpRaw.turn_rule === "string" ? mpRaw.turn_rule.slice(0, 2000) : "",
    order: orderOf(mpRaw.order),
    clock,
    tension: { mode: (t.mode === "beats" ? "beats" : "status") as "beats" | "status", maxWords: Math.floor(num(t.max_words, 25, 5, 120)), cooldownMs: num(t.cooldown_seconds, 0, 0, 3600) * 1000 },
    priv: privOf(mpRaw.private),
    seatMs: num(mpRaw.seat_days, 14, 0, 3650) * 86_400_000,
    leave: regexOf(mpRaw.leave_pattern, DEFAULT_LEAVE, "leave_pattern"),
    standing: (mpRaw.standing === "any" ? "any" : "private") as "any" | "private",
    defaultAfterField: typeof after?.real_from === "string" && /^(imeng|game)\.[\w-]+$/.test(after.real_from) ? after.real_from.replace(/^imeng\./, "game.") : undefined,
    defaultAfter: (realMs || game ? { realMs: realMs ?? undefined, game: game ?? undefined } : null) as { realMs?: number; game?: number } | null,
    defaultAction: typeof mpRaw.default_action === "string" && mpRaw.default_action.trim() ? mpRaw.default_action.trim().slice(0, 300) : "says nothing",
    // idle_vote: a player who blocks the table can be moved on by the others (/idle) once they have held it up longer than the limit the table agreed at registration (a duration like "3m",
    // read from the state path `limit`, default game.idle_after). Needs more than half of the other players (at least `min_votes`, never more than there are). Off unless this block exists.
    idleVote: mpRaw.idle_vote && typeof mpRaw.idle_vote === "object" ? { limit: typeof mpRaw.idle_vote.limit === "string" && /^(imeng|game)\.[^.\s]+$/.test(mpRaw.idle_vote.limit) ? (mpRaw.idle_vote.limit as string).replace(/^imeng\./, "game.") : "game.idle_after", minVotes: Math.max(1, Math.floor(Number(mpRaw.idle_vote.min_votes)) || 2) } : null,
    judge: mpRaw.judge !== false,
    confirm: regexOf(mpRaw.confirm_pattern, DEFAULT_CONFIRM, "confirm_pattern"),
    resetOnTalk: mpRaw.reset_on_talk !== false,
    // silenced_when: a condition on a player's own actor (for example {"field":"hp","lte":0}). A person whose character meets it is ignored in the shared chat: nothing they say changes the game or reaches the narrator, and they get silenced_reply. Their private channel still works.
    silencedWhen: mpRaw.silenced_when && typeof mpRaw.silenced_when === "object" ? mpRaw.silenced_when : null,
    silencedReply: typeof mpRaw.silenced_reply === "string" && mpRaw.silenced_reply.trim() ? mpRaw.silenced_reply.trim().slice(0, 300) : "The living do not hear you.",
    minPlayers: Math.max(1, Math.floor(Number(mpRaw.min_players ?? 2)) || 2),
    idleMs: Math.max(0, Number(mpRaw.idle_minutes ?? 0) * 60000) || 0,
    maxPlayers: Math.min(50, Math.max(2, Math.floor(Number(mpRaw.max_players ?? 8)) || 8)),
  };
})() : null;
export type MultiplayerConfig = NonNullable<typeof MULTIPLAYER>;

// knowledge (default off; needs multiplayer): facts only some people know. See docs/MULTIPLAYER.md section 11.
//   confirm_facts: player (default) | off. match: name (default) | judge. triggers: {action: none, statement: owner, candidate_turns: 3} (a trigger's own `confirm` wins).
//   transfer: off (default) | tell | covert (see docs/MULTIPLAYER.md section 11). leak: retry (default) | redact | audit | off. notes_view: a player may list/forget their own facts. seed: facts the game itself holds.
const kRaw = config.knowledge;
const kRegex = (src: unknown, dflt: string, name: string): RegExp => {
  try { return new RegExp(typeof src === "string" && src ? src : dflt, "i"); }
  catch { warn(`knowledge.${name} is not a valid regular expression: ${String(src)}; using the default`); return new RegExp(dflt, "i"); }
};
const kList = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 60)).slice(0, max) : []);
export const kTriggers = (v: unknown): FactTrigger[] => (Array.isArray(v) ? v : []).filter((t: any) => t && (t.kind === "action" || t.kind === "statement") && typeof t.when === "string" && t.when.trim()).slice(0, 4)
  .map((t: any) => ({ kind: t.kind, when: t.when.trim().slice(0, 200), by: typeof t.by === "string" && t.by.trim() ? t.by.trim().slice(0, 60) : undefined, confirm: t.confirm === "owner" || t.confirm === "none" ? t.confirm : undefined }));
export const KNOWLEDGE = kRaw && kRaw.enabled === true && !MULTIPLAYER ? (warn("knowledge is on but multiplayer is not: players have no private chat to record facts in, so knowledge is off"), null)
  : kRaw && kRaw.enabled === true ? (() => {
    const t: any = kRaw.triggers && typeof kRaw.triggers === "object" ? kRaw.triggers : {};
    const seed: Fact[] = (Array.isArray(kRaw.seed) ? kRaw.seed : []).filter((f: any) => f && typeof f.id === "string" && safeSeg(f.id) && typeof f.text === "string" && f.text.trim() && typeof f.about === "string" && f.about.trim()).slice(0, 100).map((f: any) => {
      const knownBy = kList(f.known_by, 10);
      return { id: f.id, text: f.text.trim().slice(0, 400), about: f.about.trim(), knownBy, access: (["never", "roleplaying", "dm"].includes(f.access) ? f.access : knownBy.length ? "roleplaying" : "never") as FactAccess, watch: kList(f.watch, 8), discover: kTriggers(f.discover), createdBy: "game", createdTurn: 0 };
    });
    return {
      confirmFacts: (kRaw.confirm_facts === "off" ? "off" : "player") as "player" | "off",
      match: (kRaw.match === "judge" ? "judge" : "name") as "name" | "judge",
      actionConfirm: (t.action === "owner" ? "owner" : "none") as "owner" | "none",
      statementConfirm: (t.statement === "none" ? "none" : "owner") as "owner" | "none",
      candidateTurns: Math.floor(num(t.candidate_turns, 3, 1, 50)),
      leak: (["off", "audit", "redact"].includes(kRaw.leak as string) ? kRaw.leak : "retry") as "off" | "audit" | "retry" | "redact",
      transfer: (kRaw.transfer === "tell" || kRaw.transfer === "covert" ? kRaw.transfer : "off") as "off" | "tell" | "covert",
      covertMax: Math.floor(num(kRaw.covert_max, 2, 1, 10)),
      covertWith: (kRaw.covert_with === "main" ? "main" : "judge") as "judge" | "main",
      notice: (kRaw.notice === "off" ? "off" : "seen") as "off" | "seen",
      overhear: kRaw.overhear && typeof kRaw.overhear === "object" ? (() => { const o: any = kRaw.overhear; return { base: num(o.base, 0.2, 0, 1), step: num(o.step, 0.3, 0, 1), seek: num(o.seek, 0.7, 0, 1), text: typeof o.text === "string" && o.text.trim() ? o.text.slice(0, 400) : "You catch only a fragment of what was said when {who}: \"{what}\". You know it happened; you do not know the rest.", traits: (o.traits === "none" ? "none" : "roll") as "roll" | "none", nosyField: typeof o.nosy_field === "string" && /^[\w-]+$/.test(o.nosy_field) ? o.nosy_field : "nosiness", respectField: typeof o.respect_field === "string" && /^[\w-]+$/.test(o.respect_field) ? o.respect_field : "respects_privacy" }; })() : null,
      debrief: kRaw.debrief && typeof kRaw.debrief === "object" ? (() => { const d: any = kRaw.debrief, t = (v: unknown, x: string): string => (typeof v === "string" && v.trim() ? v.slice(0, 500) : x); return { phases: (Array.isArray(d.phases) ? d.phases : ["crossing"]).filter((p: unknown): p is string => typeof p === "string" && /^[\w-]+$/.test(p)).slice(0, 20), ask: t(d.ask, "The producer asks, privately: what did you gather from what just passed ({what})? Tell me in this chat, or update your goal with /goal."), report: t(d.report, "The producer debriefs the contestants on their devices. What the NPCs gathered (private, never announced; they update what they know from it): {npc}") }; })() : null,
      notesView: kRaw.notes_view !== false,
      maxFacts: Math.floor(num(kRaw.max_facts, 60, 1, 500)),
      maxChars: Math.floor(num(kRaw.max_chars, 1500, 200, 20000)),
      auditKeep: Math.floor(num(kRaw.audit_keep, 200, 20, 2000)),
      confirm: kRegex(kRaw.confirm_pattern, "^\\s*(yes|y|save|confirm|ok|okay)[\\s.!]*$", "confirm_pattern"),
      cancel: kRegex(kRaw.cancel_pattern, "^\\s*(no|n|cancel|discard)[\\s.!]*$", "cancel_pattern"),
      notes: kRegex(kRaw.notes_pattern, "^\\s*(my )?(notes|secrets)[\\s.!?]*$", "notes_pattern"),
      forget: kRegex(kRaw.forget_pattern, "^\\s*forget\\s+(\\S+?)[\\s.!]*$", "forget_pattern"),
      seed,
    };
  })() : null;
export type KnowledgeConfig = NonNullable<typeof KNOWLEDGE>;
// MULTIPLAYER_DEBUG=1: write what each request carries (header names and values without secrets, message sizes) to SAVE_DIR/multiplayer-debug.jsonl
export const MULTIPLAYER_DEBUG = ["1", "true", "on"].includes((process.env.MULTIPLAYER_DEBUG ?? "").toLowerCase());

// MLflow tracing (default off): set MLFLOW_TRACKING_URI and MLFLOW_EXPERIMENT_ID and every game turn is sent to MLflow as one trace
// (a span per model call, over OTLP/JSON to <uri>/v1/traces). MLFLOW_CAPTURE=meta (default) sends sizes, timings, models and counts only;
// full also sends the prompts and responses (capped by LOG_PROMPT_CHARS). MLFLOW_RUN_ID links the traces to a run; MLFLOW_TRACKING_TOKEN is sent as a Bearer token.
export const MLFLOW_URI = (process.env.MLFLOW_TRACKING_URI || "").replace(/\/+$/, "");
export const MLFLOW_EXPERIMENT_ID = process.env.MLFLOW_EXPERIMENT_ID || "";
export const MLFLOW_RUN_ID = process.env.MLFLOW_RUN_ID || "";
export const MLFLOW_TOKEN = process.env.MLFLOW_TRACKING_TOKEN || "";
export const MLFLOW_CAPTURE: "meta" | "full" = process.env.MLFLOW_CAPTURE === "full" ? "full" : "meta";
/** A traced stage at least this slow (ms) is marked `bottleneck`. */
export const MLFLOW_SLOW_MS = Math.max(1, Number(process.env.MLFLOW_SLOW_MS || 2000)) || 2000;
export const MLFLOW_TIMEOUT_MS = Math.max(500, Number(process.env.MLFLOW_TIMEOUT_MS || 5000)) || 5000;
export const MLFLOW_DEBUG = ["1", "true", "on"].includes((process.env.MLFLOW_DEBUG ?? "").toLowerCase()); // log each export's size and time
/** MLFLOW_EXPERIMENT_PER_CHAT or --experiment-per-chat: every chat session gets its own experiment, named after the model, the time and the session (created when missing). */
export const MLFLOW_PER_CHAT = experimentPerChat();
/** TELEMETRY=off or --no-telemetry: the server sends nothing to MLflow. */
export const TELEMETRY_ENABLED = telemetryEnabled();
export const MLFLOW_ON = TELEMETRY_ENABLED && /^https?:\/\//.test(MLFLOW_URI) && (!!MLFLOW_EXPERIMENT_ID || MLFLOW_PER_CHAT);

// NODE_ENV=production (or ENV=production): the narrator model and the judge are assumed to be always on, at UPSTREAM and JUDGE_URL (or judge_instance's
// host and port), and are never spawned; sessions go to Redis when REDIS_URL is set. Anything else is development: the judge is started on the
// next port when needed, and sessions are files (npm start) or memory only (npm run start:ephemeral).
/** DATABASE_URL (postgres://... or sqlite:...): the bookkeeping database. Unset: no database, nothing to check. */
export const DATABASE_URL = process.env.DATABASE_URL || "";
/** How often the database's version stamp is re-read (it is also read at the start of every game turn). */
export const STATE_PROBE_MS = Math.max(200, Number(process.env.STATE_PROBE_MS || 5000)) || 5000;
/** STATE_EXIT=off: a bad stamp is logged and the instance carries on (debugging only). */
export const STATE_EXIT = (process.env.STATE_EXIT ?? "").toLowerCase() !== "off";
export const PRODUCTION = ["NODE_ENV", "ENV"].some((k) => (process.env[k] ?? "").toLowerCase() === "production");
// SESSION_STORE: auto (default: Redis in production when REDIS_URL is set, else files), file, or redis. --no-persist (start:ephemeral) always means memory only.
export const SESSION_STORE: "auto" | "file" | "redis" = ["file", "redis"].includes((process.env.SESSION_STORE ?? "").toLowerCase()) ? (process.env.SESSION_STORE!.toLowerCase() as "file" | "redis") : "auto";
// Redis keys of this game's sessions start with SESSION_PREFIX (default imeng:<model_id>), so games can share a Redis. SESSION_TTL_DAYS: how long an idle session is kept.
export const SESSION_PREFIX = (process.env.SESSION_PREFIX || `imeng:${MODEL_ID}`).replace(/:+$/, "");
export const SESSION_TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)) || 30;
// The per-session lock that serializes turns across proxy servers: held with a lease that is renewed while the turn runs (LOCK_TTL_MS), waited for at most LOCK_WAIT_MS.
export const LOCK_TTL_MS = Math.max(2000, Number(process.env.LOCK_TTL_MS || 60000)) || 60000;
export const LOCK_WAIT_MS = Math.max(1000, Number(process.env.LOCK_WAIT_MS || 300000)) || 300000;

// tools (config.json): which tools the narrator may call and each one's limits. Secrets and endpoints are in tools.config.mjs (see docs/TOOLS.md).
//   {"tools": {"tmdb": {"max_calls_per_turn": 4}, "fetch": {"hosts": ["api.example.com"], "methods": ["GET"], "max_bytes": 200000}}, "tool_rounds": 3}
// Every tool takes max_calls_per_turn (default 3), max_chars (a result is cut to this many characters, 6000) and timeout_ms (15000).
export const TOOLS: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries((config.tools && typeof config.tools === "object" ? config.tools : {}) as Record<string, unknown>)
    .filter(([name, o]) => /^[a-z][a-z0-9_]{0,40}$/.test(name) && o && typeof o === "object" && !Array.isArray(o)) as [string, Record<string, unknown>][],
);
export const TOOL_ROUNDS = Math.max(1, Math.min(8, Math.floor(Number(config.tool_rounds ?? 3)) || 3));

// sync (config.json): keep the record in step with the conversation. mode off | detect (default: fingerprints and an audit log, nothing repaired) | repair.
//   replay_turns: at most this many of the latest turns are replayed when the record is rebuilt (10); batch: turns per extractor call (4);
//   similarity: how much of a reply (0 to 1) must still match its fingerprint for an edited reply not to count as changed (0.7); audit_keep: log entries kept (200).
const syncRaw: any = config.sync && typeof config.sync === "object" ? config.sync : {};
const syncNum = (v: unknown, d: number, lo: number, hi: number): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export const SYNC = {
  mode: (["off", "repair"].includes(syncRaw.mode) ? syncRaw.mode : "detect") as "off" | "detect" | "repair",
  replayTurns: syncNum(syncRaw.replay_turns, 10, 1, 60),
  batch: syncNum(syncRaw.batch, 4, 1, 12),
  similarity: Math.min(1, Math.max(0.1, Number.isFinite(Number(syncRaw.similarity)) ? Number(syncRaw.similarity) : 0.7)),
  auditKeep: syncNum(syncRaw.audit_keep, 200, 20, 2000),
};
export type SyncConfig = typeof SYNC;
