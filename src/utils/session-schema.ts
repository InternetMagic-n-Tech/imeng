import { MIGRATIONS } from "./migrations/index.js";
import type { Cfg, Migration } from "./migrations/index.js";

/*
 * Saved sessions are stamped with the schema_version config.json declared when they were written (unstamped = 1). A session written under another
 * version loads only if every migration between the two has a `session` step; otherwise SESSION_SCHEMA decides: refuse (default, the server
 * will not start), warn (start and say so), off (no check).
 */
export type SchemaMode = "refuse" | "warn" | "off";
export class SchemaMismatch extends Error {}
export interface SchemaVerdict { action: "ok" | "migrate" | "refuse" | "warn"; from: number; to: number; note?: string }

export const stampOf = (doc: unknown): number => { const v = (doc as { schema_version?: unknown } | null)?.schema_version; return Number.isInteger(v) && (v as number) >= 1 ? (v as number) : 1; };

const chain = (from: number, to: number, list: Migration[]): Migration[] | null => {
  const steps: Migration[] = [];
  for (let v = from; v < to; v++) { const m = list.find((x) => x.from === v && x.to === v + 1); if (!m?.session) return null; steps.push(m); }
  return steps;
};

export function judgeSchema(doc: unknown, now: number, mode: SchemaMode, list: Migration[] = MIGRATIONS): SchemaVerdict {
  const from = stampOf(doc);
  if (from === now || mode === "off") return { action: "ok", from, to: now };
  if (from < now && chain(from, now, list)) return { action: "migrate", from, to: now };
  const why = from > now ? "newer than this config.json (no way back)" : "no session migration exists for it";
  return { action: mode === "warn" ? "warn" : "refuse", from, to: now, note: `was saved under config.json schema_version ${from}, the game is at ${now}: ${why}` };
}

/** Bring a saved document up to `to` by running each migration's session step. Call only after judgeSchema said "migrate". */
export function upgradeDoc(doc: Cfg, from: number, to: number, list: Migration[] = MIGRATIONS): Cfg {
  let d = doc;
  for (const m of chain(from, to, list) ?? []) d = { ...m.session!(d), schema_version: m.to };
  return { ...d, schema_version: to };
}

/** The startup check over everything stored: a message naming the problem and the way out, or null. */
export function schemaProblem(docs: Iterable<{ key: string; doc: unknown }>, now: number, mode: SchemaMode, list: Migration[] = MIGRATIONS, limit = 5000): string | null {
  if (mode !== "refuse") return null;
  const bad: string[] = [];
  let n = 0;
  for (const { key, doc } of docs) {
    if (++n > limit) break;
    const v = judgeSchema(doc, now, mode, list);
    if (v.action === "refuse") bad.push(`${key} (v${v.from})`);
  }
  if (!bad.length) return null;
  return `Refusing to start: ${bad.length} stored session(s) were saved under another config.json schema_version than the game's ${now} and have no migration path (${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ", ..." : ""}). Fix: write the migration's session step (utils/migrations/README.md), clear them (npm run sessions -- clear), or set SESSION_SCHEMA=warn to start anyway.`;
}
