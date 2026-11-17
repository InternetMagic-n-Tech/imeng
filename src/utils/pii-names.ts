import crypto from "node:crypto";
import { PII_FILTER, type NameClass, type NameMapping } from "./pii-filter-config.js";
import { token } from "./pii-filter.js";
import { judgeJSON } from "./judge.js";
import { dbg } from "./debug.js";

/**
 * The name layer of the PII filter (config.json pii_filter.names): a small local model finds people, animals and sensitive facts in the player's
 * messages and code decides everything else: which class each becomes (the game's `mappings`, with the judge only picking between listed options),
 * the token ([uncle:3fa9c2], [animal:..], [sensitive:..]), and the table that puts real names back in the narrator's reply. The table lives only
 * for the request: the player's messages are replayed in full on every request, so it is rebuilt each time and never stored. Secrets are not here
 * (they are the regex kinds) and are never restored.
 */
export interface Mention { text: string; name?: string; kind: string; relation?: string; multiple?: boolean | number }
export type Detector = (text: string) => Promise<Mention[]>;
export type Chooser = (m: Mention, options: NameClass[], question: string, sentence: string) => Promise<NameClass | "keep" | null>;

const DETECT_PROMPT = `You find personal details about real people in a message. Output ONLY JSON: {"mentions":[...]}. Each mention: {"text": the exact words from the message (for "Uncle Joe" the text is "Uncle Joe"), "name": the personal name alone if there is one, "kind": one of person | animal | role | relation | health | religion | politics | orientation, "relation": how the person relates to the speaker if stated (uncle, mother, boss, priest, doctor, twin_brother...), "multiple": true if they are a twin, triplet or other multiple birth or a litter-mate}.
Use "animal" only for a NAMED pet or named livestock ("Bessie the cow"), never an unnamed "my cow". Use health, religion, politics or orientation for a phrase that states such a fact about a person. Do not list fictional characters, places or brands. If there is nothing, {"mentions":[]}. Be terse; copy words exactly.`;

const DEFAULT_QUESTION = "Does this phrase state something sensitive about the named person (their religion, health, politics or orientation) beyond who they are to the speaker? Answer with `sensitive` if so, otherwise `person`.";

const BUILTIN: NameMapping[] = [
  { from: ["person"], to: ["person"] },
  { from: ["animal"], to: ["animal"] },
  { from: ["other"], to: ["other"] },
  { from: ["health", "religion", "politics", "orientation", "sensitive"], to: ["sensitive"] },
  { from: ["role", "relation"], to: ["person", "sensitive"], judge: DEFAULT_QUESTION },
];

/** The mapping for a kind: the game's own first, then the built-in one; none means "leave it clear". */
export const mappingFor = (kind: string, own: NameMapping[] = PII_FILTER?.mappings ?? []): NameMapping | undefined => {
  const k = kind.toLowerCase();
  return own.find((m) => m.from.includes(k)) ?? BUILTIN.find((m) => m.from.includes(k));
};

/** Decide the class of one mention: one option decides itself; several go to the chooser, and a failure or a bad answer takes the most protective (the last). */
export async function classify(m: Mention, sentence: string, choose: Chooser, own?: NameMapping[]): Promise<NameClass | "keep"> {
  const map = mappingFor(m.kind, own);
  if (!map) return "keep";
  const opts = [...new Set(map.to)];
  if (opts.length === 1) return opts[0]!;
  const real = opts.filter((o): o is NameClass => o !== "keep");
  try {
    const v = await choose(m, real, map.judge || DEFAULT_QUESTION, sentence);
    if (v && opts.includes(v)) return v;
  } catch { /* fall through to the safest */ }
  return opts[opts.length - 1]!;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);

/** The token for a mention of a class: a person keeps their relation or role beside the name hash, so the narrator still knows who they are to the player. */
export function nameToken(m: Mention, cls: NameClass): string {
  const who = (m.name || m.text).trim();
  if (cls === "sensitive" || cls === "other") return token(cls, m.text);
  if (cls === "animal") return token(m.multiple ? "animal+multiple" : "animal", who);
  const rel = slug(m.relation || "") || "person";
  return token(m.multiple && rel !== "person" ? `${rel}+multiple` : rel, who);
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (s: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s)}(?![\\p{L}\\p{N}])`, "giu");

const cache = new Map<string, { mentions: Mention[]; classes: (NameClass | "keep")[] }>();
const CACHE_MAX = 2000;
const hash = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Skip the model for text with no capital letter and only a few words ("go north"). */
export const worthChecking = (t: string): boolean => t.trim().length > 2 && (/\p{Lu}/u.test(t) || t.trim().split(/\s+/).length > 4);

export interface NameResult { text: string; table: Map<string, string>; found: number }

/** Mask the names in one text. Throws when the detector fails (the caller refuses the message). */
export async function scrubNameText(text: string, deps: { detect: Detector; choose: Chooser; extra?: Detector; classes?: NameClass[]; mappings?: NameMapping[] }): Promise<NameResult> {
  const table = new Map<string, string>();
  if (!worthChecking(text)) return { text, table, found: 0 };
  const classes = deps.classes ?? PII_FILTER?.classes ?? (["person", "animal", "sensitive", ...(deps.extra ? ["other"] : [])] as NameClass[]);
  const key = hash(text);
  let hit = cache.get(key);
  if (!hit) {
    const found = [...(await deps.detect(text)), ...(deps.extra ? await deps.extra(text) : [])]; // a failing extra detector throws too: no silent misses
    const mentions = found.filter((m) => m && typeof m.text === "string" && m.text.trim() && text.includes(m.text));
    const classesOf: (NameClass | "keep")[] = [];
    for (const m of mentions) classesOf.push(await classify(m, text.slice(Math.max(0, text.indexOf(m.text) - 80), text.indexOf(m.text) + m.text.length + 80), deps.choose, deps.mappings));
    hit = { mentions, classes: classesOf };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, hit);
  }
  let out = text, found = 0;
  // longer phrases first, so "Uncle Joe" is one token and a later bare "Joe" gets the same one
  const order = hit.mentions.map((m, i) => ({ m, c: hit!.classes[i]! })).filter((x) => x.c !== "keep" && classes.includes(x.c)).sort((a, b) => b.m.text.length - a.m.text.length);
  for (const { m, c } of order) {
    const t = nameToken(m, c as NameClass);
    for (const target of [m.text, ...(c === "person" && m.name && m.name !== m.text ? [m.name] : [])]) {
      out = out.replace(wordRe(target), () => { found++; table.set(t, c === "person" ? m.text : m.text); return t; });
    }
  }
  return { text: out, table, found };
}

const NEW_CLASS_PROMPT = `You look for private details in a message that a normal name-and-contact filter would miss. Already handled elsewhere, so DO NOT list them: names of people and pets, who someone is to the speaker, health, religion, politics, orientation, emails, phone numbers, card numbers, ID numbers, IP addresses.
List anything else that is private to a real person: a PIN or passcode, a home or work address, a town or neighbourhood, an employer or school, a licence plate, an account name, a medical record number, a birth date, where something valuable is kept. Fictional game details are not private.
Output ONLY JSON: {"mentions":[{"text": the exact words from the message, "label": a short lowercase name for the kind of data, like "pin" or "address"}]} or {"mentions":[]}.`;

/** The new-class judge: finds private data the class list does not name. It is masked as [other:...] and only the label is logged, never the value. */
export const newClassDetector: Detector = async (text) => {
  const v = await judgeJSON(NEW_CLASS_PROMPT, `<message>\n${text.slice(0, 2000)}\n</message>`, "pii-newclass", 300);
  if (!v || !Array.isArray(v.mentions)) throw new Error("no mentions list");
  return v.mentions.flatMap((m: any) => {
    if (typeof m?.text !== "string" || !m.text.trim()) return [];
    console.warn(`[pii] new class: ${String(m.label || "unlabelled").toLowerCase().replace(/[^a-z0-9 _-]/g, "").slice(0, 30)} (masked as other)`);
    return [{ text: m.text, kind: "other" } as Mention];
  });
};

/** The real detector: the local judge model, with the prompts this file owns. */
export const modelDetector: Detector = async (text) => {
  const v = await judgeJSON(DETECT_PROMPT, `<message>\n${text.slice(0, 2000)}\n</message>`, "pii-names", 400);
  if (!v || !Array.isArray(v.mentions)) throw new Error("no mentions list");
  return v.mentions.flatMap((m: any) => typeof m?.text === "string" && typeof m?.kind === "string"
    ? [{ text: m.text, name: typeof m.name === "string" && m.name ? m.name : undefined, kind: m.kind.toLowerCase(), relation: typeof m.relation === "string" ? m.relation : undefined, multiple: m.multiple === true || typeof m.multiple === "number" ? m.multiple : undefined }]
    : []);
};
export const modelChooser: Chooser = async (m, options, question, sentence) => {
  const v = await judgeJSON(`${question}\nReply ONLY JSON: {"class": ${options.map((o) => `"${o}"`).join(" | ")}}. Be terse.`, `<phrase>${m.text}</phrase>\n<context>${sentence}</context>`, "pii-map", 60);
  return typeof v?.class === "string" ? (v.class as NameClass) : null;
};

type Msg = { role?: string; content?: unknown; [k: string]: unknown };

/** Mask the names in the player's messages (not the game's own system messages). The table is for restoring them in the reply. */
export async function scrubNameMessages<T extends Msg>(messages: T[], deps: { detect: Detector; choose: Chooser; extra?: Detector } = { detect: modelDetector, choose: modelChooser, extra: PII_FILTER?.newClass ? newClassDetector : undefined }): Promise<{ messages: T[]; table: Map<string, string>; found: number }> {
  const table = new Map<string, string>();
  let found = 0;
  const one = async (t: string): Promise<string> => { const r = await scrubNameText(t, deps); r.table.forEach((v, k) => table.set(k, v)); found += r.found; return r.text; };
  const out: T[] = [];
  for (const m of messages) {
    if (m.role !== "user") { out.push(m); continue; }
    if (typeof m.content === "string") { const t = await one(m.content); out.push(t === m.content ? m : { ...m, content: t }); continue; }
    if (Array.isArray(m.content)) { out.push({ ...m, content: await Promise.all(m.content.map(async (p: any) => (p && typeof p.text === "string" ? { ...p, text: await one(p.text) } : p))) }); continue; }
    out.push(m);
  }
  dbg("pii")("names: %d masked", found);
  return { messages: out, table, found };
}

/** Puts real names back into the narrator's reply as it streams; text that may be the start of a token is held until it is complete. */
export class Restorer {
  private hold = "";
  constructor(private table: Map<string, string>) {}
  get active(): boolean { return this.table.size > 0; }
  push(t: string): string {
    if (!this.table.size) return t;
    let s = this.hold + t; this.hold = "";
    const i = s.lastIndexOf("[");
    if (i >= 0 && s.indexOf("]", i) < 0 && s.length - i <= 40) { this.hold = s.slice(i); s = s.slice(0, i); }
    return this.swap(s);
  }
  end(): string { const s = this.hold; this.hold = ""; return this.swap(s); }
  swap(s: string): string { for (const [tok, real] of this.table) if (s.includes(tok)) s = s.split(tok).join(real); return s; }
}
