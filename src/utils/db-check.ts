import fs from "node:fs";
import { sql } from "kysely";
import { openDb } from "./db.js";
import { migrateUp, MIGRATION_NAMES } from "./db-migrations.js";
import { expectedStamp } from "./db-state.js";

/**
 * A throwaway database for a test: built fresh from the migrations, seeded with rows, then one query is run and its outcome compared exactly.
 * `seed` is {table: [row, ...]}; `query` is SQL text with ? placeholders and `params`; `expect` is {rows: [...]} (same order unless `unordered`) or {count: n} or {none: true}.
 */
export interface DbCheck {
  seed?: Record<string, Record<string, unknown>[]>;
  query: string;
  params?: unknown[];
  expect: { rows?: Record<string, unknown>[]; count?: number; none?: boolean; unordered?: boolean };
  /** postgres://... or sqlite:... (default sqlite::memory:). */
  url?: string;
}
export interface DbCheckResult { ok: boolean; got: Record<string, unknown>[]; problems: string[]; migrations: string[] }

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : typeof x === "bigint" ? Number(x) : x));

export async function runDbCheck(c: DbCheck): Promise<DbCheckResult> {
  const db = await openDb(c.url || "sqlite::memory:");
  try {
    await migrateUp(db, expectedStamp());
    for (const [table, rows] of Object.entries(c.seed ?? {})) if (rows.length) await db.insertInto(table).values(rows).execute();
    const parts = c.query.split("?");
    const params = c.params ?? [];
    if (parts.length - 1 !== params.length) throw new Error(`the query has ${parts.length - 1} placeholders and ${params.length} params`);
    const frag = sql.join(parts.flatMap((p, i) => (i < params.length ? [sql.raw(p), sql.val(params[i])] : [sql.raw(p)])), sql``);
    const got = ((await frag.execute(db)).rows ?? []) as Record<string, unknown>[];
    const problems: string[] = [];
    const e = c.expect;
    if (e.none && got.length) problems.push(`expected no rows, got ${got.length}`);
    if (e.count !== undefined && got.length !== e.count) problems.push(`expected ${e.count} row(s), got ${got.length}`);
    if (e.rows) {
      const a = e.rows.map(stable), b = got.map(stable);
      if (e.unordered) { a.sort(); b.sort(); }
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) problems.push(`rows differ:\nexpected ${JSON.stringify(e.rows)}\ngot      ${JSON.stringify(got)}`);
    }
    return { ok: !problems.length, got, problems, migrations: MIGRATION_NAMES };
  } finally { await db.destroy(); }
}

/** `driver db <file.json>` reads a DbCheck from a file (or a JSON string); returns the exit code. */
export async function dbCheckMain(arg: string, out: (m: string) => void = console.log): Promise<number> {
  const raw = fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
  const r = await runDbCheck(JSON.parse(raw) as DbCheck);
  out(r.ok ? `ok (${r.got.length} row(s))` : r.problems.join("\n"));
  return r.ok ? 0 : 1;
}
