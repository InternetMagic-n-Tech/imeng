import { config } from "./config.js";

/** config.json `pii_filter` (off unless the block exists): what is kept out of every model, log and trace. See docs/DESIGN.md. */
export const CATEGORIES = ["email", "phone", "card", "id_number", "ip", "secret"] as const;
export type Category = (typeof CATEGORIES)[number];

export type NameClass = "person" | "animal" | "sensitive" | "other";
export interface NameMapping { from: string[]; to: (NameClass | "keep")[]; judge?: string }

const p: any = config.pii_filter && typeof config.pii_filter === "object" ? config.pii_filter : null;
const re = (src: unknown): RegExp | null => { try { return typeof src === "string" && src ? new RegExp(src, "gi") : null; } catch { return null; } };

export const PII_FILTER = p ? {
  detect: (Array.isArray(p.detect) ? p.detect.filter((c: string) => (CATEGORIES as readonly string[]).includes(c)) : [...CATEGORIES]) as Category[],
  onDetect: (["mask", "block", "allow"].includes(p.on_detect) ? p.on_detect : "mask") as "mask" | "block" | "allow",
  allow: (Array.isArray(p.allow) ? p.allow.filter((a: unknown): a is string => typeof a === "string") : []).map((a: string) => a.toLowerCase()),
  patterns: (Array.isArray(p.patterns) ? p.patterns : []).flatMap((x: any) => { const r = re(x?.regex); return r && typeof x?.name === "string" && /^[a-z][a-z0-9_]*$/.test(x.name) ? [{ name: x.name as string, regex: r }] : []; }) as { name: string; regex: RegExp }[],
  names: p.names === true,
  newClass: p.new_class_judge === true,
  classes: (Array.isArray(p.classes) ? p.classes.filter((c: unknown) => ["person", "animal", "sensitive", "other"].includes(c as string)) : p.new_class_judge === true ? ["person", "animal", "sensitive", "other"] : ["person", "animal", "sensitive"]) as NameClass[],
  mappings: (Array.isArray(p.mappings) ? p.mappings : []).flatMap((m: any) => Array.isArray(m?.from) && Array.isArray(m?.to) && m.to.length ? [{ from: m.from.map((x: unknown) => String(x).toLowerCase()), to: m.to as (NameClass | "keep")[], judge: typeof m.judge === "string" ? m.judge : undefined }] : []) as NameMapping[],
  restore: p.restore !== false,
  placeholders: { secret: "[SECRET]", ...(p.placeholders && typeof p.placeholders === "object" ? Object.fromEntries(Object.entries(p.placeholders).filter(([, v]) => typeof v === "string")) : {}) } as Record<string, string>,
  texts: (p.texts && typeof p.texts === "object" ? p.texts : {}) as Record<string, string>,
} : null;

export const piiText = (key: string): string => PII_FILTER?.texts[key] ?? ({ detector_failed: "I could not check that message for personal details just now, so I have not read it. Please try again in a moment.", blocked: "That message looks like it has personal details in it (like an email, phone or card number), so I haven't read it. Please leave them out and send it again." } as Record<string, string>)[key] ?? key;
