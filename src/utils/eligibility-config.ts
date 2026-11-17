import { config, MODEL_ID } from "./config.js";

/** config.json `eligibility` (off unless it exists): named flags compiled to a bitmask, and who may join. See docs/DESIGN.md. */

export interface FlagRule { flag: string; path: string; op: string; value?: unknown; latch?: boolean }
export interface EligibilityCfg {
  version: number;
  flags: string[];
  require: string[];
  block: string[];
  /** The flag /optin and /optout set for the player. */
  optIn: string | null;
  rules: FlagRule[];
  ttlMs: number;
  texts: Record<string, string>;
}

const e: any = config.eligibility && typeof config.eligibility === "object" ? config.eligibility : null;
const flags: string[] = e && Array.isArray(e.flags) ? e.flags.filter((f: unknown): f is string => typeof f === "string" && /^[a-z][a-z0-9_]*$/.test(f)).slice(0, 31) : [];
const known = (l: unknown): string[] => (Array.isArray(l) ? l.filter((f): f is string => typeof f === "string" && flags.includes(f)) : []);

export const ELIGIBILITY: EligibilityCfg | null = e ? {
  version: Math.max(1, Math.floor(Number(e.version)) || 1),
  flags,
  require: known(e.join?.require),
  block: known(e.join?.block),
  optIn: typeof e.opt_in === "string" && flags.includes(e.opt_in) ? e.opt_in : null,
  rules: (Array.isArray(e.rules) ? e.rules : []).filter((r: any) => r && flags.includes(r.flag) && /^actors\.\*\.[\w]+$/.test(String(r.path)) && typeof r.op === "string")
    .map((r: any) => ({ flag: r.flag, path: r.path, op: r.op, value: r.value, latch: !!r.latch })),
  ttlMs: 30 * 86_400_000,
  texts: e.texts && typeof e.texts === "object" ? e.texts : {},
} : null;
export const GAME_ID = MODEL_ID;

const TEXTS: Record<string, string> = {
  cannot_join: "You can't join this game yet: {missing}.",
  missing: "you still need {list}",
  blocked: "{list} stops you",
  opted_in: "You're opted in for the next game.",
  opted_out: "You're opted out of the next game.",
  no_opt: "There is nothing to opt in to here.",
  no_db: "That needs the database, which is not on.",
};
export const eligibilityText = (key: string, v: Record<string, string> = {}): string => (ELIGIBILITY?.texts[key] ?? TEXTS[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
