import path from "node:path";
import { judgeState } from "./state-guard.js";
import { expectedStamp } from "./db-state.js";
import type { Finding, Sys, Settings } from "./doctor.js";

/** Doctor checks for the bookkeeping database (env DATABASE_URL). Nothing is reported when it is not set. It only reports; `npm run db:migrate` applies. */

const f = (level: Finding["level"], id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level, title, detail, fix });

export async function checkMigrations({ sys, s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  if (!s.databaseUrl || !sys.dbState) return [];
  const want = s.dbExpected ?? expectedStamp();
  const got = await sys.dbState(s.databaseUrl);
  if ("error" in got) return [f("fail", "migrations-reachable", "The database cannot be read", got.error, "Check DATABASE_URL and that Postgres is up (docker compose up -d postgres).")];
  const out: Finding[] = [f("ok", "migrations-reachable", "The database answers")];
  const v = judgeState(got, want);
  if (v.ok) out.push(f("ok", "migrations-stamp", `Database is at ${want.migrations.at(-1) ?? "no migrations"} and its version stamp matches`));
  else out.push(f("fail", /ahead/.test(v.reason!) ? "migrations-ahead" : /pending/.test(v.reason!) ? "migrations-pending" : "migrations-stamp", `Database: ${v.reason}`, `expected ${v.expected}, found ${v.found}`,
    /ahead/.test(v.reason!) ? "A newer deployment migrated it: deploy that version here too." : "Run: npm run db:migrate"));
  const text = sys.readFile(path.join(s.gameDir, "HOW_TO_TEST.md")) ?? "";
  const made = /last database migration:\s*`?([\w-]+)`?/i.exec(text)?.[1];
  if (!made) out.push(f("info", "migrations-game", "The game does not record the database migration it was written against", "Add a line to HOW_TO_TEST.md: Last database migration: <name>."));
  else if (!want.migrations.includes(made) && !want.gameMigrations?.includes(made)) out.push(f("warn", "migrations-game", `The game was written against migration ${made}, which this code does not have`, `This code knows up to ${want.migrations.at(-1)}${want.gameMigrations?.length ? ` (the game's own: ${want.gameMigrations.at(-1)})` : ""}.`, "Update the game or deploy the newer code."));
  else if (!got.applied.includes(made) && !got.appliedGame?.includes(made)) out.push(f("warn", "migrations-game", `The game was written against migration ${made}, which the database has not applied`, undefined, "Run: npm run db:migrate"));
  else out.push(f("ok", "migrations-game", `The game's last recorded migration (${made}) is applied`));
  return out;
}
