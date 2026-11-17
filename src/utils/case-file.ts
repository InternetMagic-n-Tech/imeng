import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import { renderTemplate } from "./md-template.js";

/*
 * A test case is one markdown file (links to shared parts work like any template): a header block, `## Steps` and `## Expect`.
 *   header   game, name, models {narrator, judge}, state (merged onto the starting state; or state_file), history (messages, or a file),
 *            private (notes sent before the steps; or a file), chat (the session id), who
 *   Steps    a numbered list: `1. Gus: "Omaha. All in."`   (the speaker is optional; the text may be quoted)
 *   Expect   a list; each line `state: <path> <op> <value>`, `text: contains|not contains|matches <text>` (any reply; `last` for the final one) or `judge: <question>`
 */

export interface Message { role: "user" | "assistant" | "system"; content: string }
export interface Step { who?: string; text: string }
export type Check =
  | { kind: "state"; path: string; op: string; value: unknown; line: string }
  | { kind: "text"; op: "contains" | "not contains" | "matches"; value: string; scope: "any" | "last"; line: string }
  | { kind: "judge"; question: string; line: string };
export interface Case { file: string; name: string; game: string; models: { narrator?: string; judge?: string }; state: Record<string, unknown>; history: Message[]; private: string[]; chat: string; steps: Step[]; checks: Check[]; template: string[] }

const OPS = ["==", "!=", ">=", "<=", ">", "<", "contains", "present"];
const unquote = (s: string): string => { const t = s.trim(); return /^(["“]).*(["”])$/s.test(t) ? t.slice(1, -1) : t; };
const value = (s: string): unknown => { const t = s.trim(); try { return JSON.parse(t); } catch { return unquote(t); } };

function section(body: string, title: string): string[] {
  const m = new RegExp(`^##\\s+${title}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi").exec(body);
  return (m?.[1] ?? "").split("\n").map((l) => l.trim()).filter((l) => /^(\d+[.)]|[-*])\s+/.test(l)).map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, "").trim());
}

export function parseCheck(line: string): Check {
  const m = /^(state|text|judge)\s*:\s*(.+)$/is.exec(line);
  if (!m) throw new Error(`unknown expectation: ${line}`);
  const [, kind, rest] = m;
  if (kind.toLowerCase() === "judge") return { kind: "judge", question: unquote(rest), line };
  if (kind.toLowerCase() === "text") {
    const t = /^(last\s+|any\s+)?(not contains|contains|matches)\s+(.+)$/is.exec(rest.trim());
    if (!t) throw new Error(`text expectation needs contains, not contains or matches: ${line}`);
    return { kind: "text", scope: t[1]?.trim().toLowerCase() === "last" ? "last" : "any", op: t[2].toLowerCase() as "contains", value: unquote(t[3].replace(/\s{2,}\(.*\)\s*$/, "")), line };
  }
  const s = /^(\S+)\s+(==|!=|>=|<=|>|<|contains|present)\s*(.*)$/is.exec(rest.trim());
  if (!s || !OPS.includes(s[2])) throw new Error(`state expectation is "<path> <op> <value>": ${line}`);
  return { kind: "state", path: s[1], op: s[2], value: s[2] === "present" ? true : value(s[3].replace(/\s{2,}\(.*\)\s*$/, "")), line };
}

/** A value written inline, or the path of a JSON/YAML file, or (from a flag) a JSON/YAML string. */
const loadMaybe = <T,>(v: unknown, dir: string): T | undefined => {
  if (typeof v !== "string") return v as T | undefined;
  const f = path.resolve(dir, v);
  if (!fs.existsSync(f)) { if (/^\s*[[{]/.test(v)) return YAML.parse(v) as T; throw new Error(`file not found: ${f}`); }
  const raw = fs.readFileSync(f, "utf8");
  return (f.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw)) as T;
};

export interface Over { game?: string; state?: string; history?: string; private?: string; chat?: string }
/** `over` is what the command line passed; it wins over the header. */
export function parseCase(file: string, over: Over = {}): Case {
  const { text, files } = renderTemplate(file);
  const fm = matter(text, { engines: { yaml: (s: string) => YAML.parse(s) } });
  const h = fm.data as Record<string, any>;
  const dir = path.dirname(file);
  const game = over.game ?? h.game;
  if (!game) throw new Error(`${file}: the header needs a game`);
  const steps = section(fm.content, "Steps").map((s) => { const m = /^([A-Za-z][\w .'-]{0,30}):\s+(.+)$/s.exec(s); return m && !/^["“]/.test(s) ? { who: m[1].trim(), text: unquote(m[2]) } : { text: unquote(s) }; });
  if (!steps.length) throw new Error(`${file}: no steps (a numbered list under "## Steps")`);
  const cwd = process.cwd();
  const state = loadMaybe<Record<string, unknown>>(over.state ?? h.state ?? h.state_file, over.state ? cwd : dir) ?? {};
  const history = loadMaybe<Message[]>(over.history ?? h.history, over.history ? cwd : dir) ?? [];
  const priv = loadMaybe<string[]>(over.private ?? h.private, over.private ? cwd : dir) ?? [];
  return {
    file, name: String(h.name || path.basename(file).replace(/(\.case)?\.md$/, "")), game: path.resolve(dir, String(game)), models: h.models ?? {},
    state, history, private: priv.map(String), chat: String(over.chat || h.chat || `case-${path.basename(file).replace(/\W+/g, "-")}`),
    steps, checks: section(fm.content, "Expect").map(parseCheck), template: files,
  };
}
