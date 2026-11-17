import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Migrator } from "kysely/migration";
import type { MigrationProvider, Migration } from "kysely/migration";
import type { Db } from "./db.js";

/**
 * The database's migrations are files, Knex-style: `migrations/NNN_name.mjs` for the engine and `imengs/<game>/migrations/NNN_name.mjs` for one imeng, each exporting
 * `up(db)` and `down(db)` (a Kysely instance). Names sort in the order they run; files that do not match NNN_name.mjs (the .md docs, a template) are ignored.
 * The engine's run is recorded in Kysely's `kysely_migration` table, a game's in `kysely_migration_<game>`, and the stamp the running code expects is below.
 * Never edit a migration that has shipped: add a new one. Record the last one in a game's HOW_TO_TEST.md. A game's tables are named `<game>_<table>`.
 */
const FILE = /^(\d{3}_[a-z0-9_]+)\.mjs$/;
const here = path.dirname(fileURLToPath(import.meta.url));

/** The engine's migrations folder: MIGRATIONS_DIR, else ./migrations (the repo root or /app), else next to the built or source files. */
export function engineDir(): string {
  const found = [process.env.MIGRATIONS_DIR, path.resolve(process.cwd(), "migrations"), path.resolve(here, "..", "migrations"), path.resolve(here, "..", "..", "migrations")].filter((x): x is string => !!x).find((d) => fs.existsSync(d));
  return found ?? path.resolve(process.cwd(), "migrations");
}
/** The migration names in a folder, in run order; an absent folder has none. */
export function migrationNames(dir: string): string[] {
  try { return fs.readdirSync(dir).flatMap((f) => { const m = FILE.exec(f); return m ? [m[1]] : []; }).sort(); } catch { return []; }
}
/** A Kysely provider that loads each file when it is needed. */
export function fileProvider(dir: string): MigrationProvider {
  return { getMigrations: async () => {
    const out: Record<string, Migration> = {};
    for (const name of migrationNames(dir)) {
      const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(dir, `${name}.mjs`)).href);
      if (typeof mod.up !== "function") throw new Error(`migration ${name} in ${dir} has no up(db)`);
      out[name] = { up: mod.up, down: mod.down };
    }
    return out;
  } };
}
/** The table that records one game's migrations (a game id may hold only letters, digits, dashes and underscores). */
export const gameTable = (gameId: string): string => `kysely_migration_${gameId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

export const MIGRATION_NAMES = migrationNames(engineDir());
/** Bump when the eligibility rules' meaning changes (stage 4); the stamp then no longer matches until `db:migrate` is run. */
export const RULES_VERSION = "1";

export interface Expected { rules: string; game: string; proxy: string; migrations: string[]; /** The game and its flag version: eligibility rows of another version are reset by db:migrate. */ eligibility?: { game: string; version: number };
  /** One imeng's own migrations: its id (the model id), the folder (imengs/<game>/migrations) and the names found there. */ gameId?: string; gameDir?: string; gameMigrations?: string[] }

/** Apply the pending migrations and write the stamp. Returns the names that ran. */
export async function migrateUp(db: Db, expected: Expected): Promise<string[]> {
  const { results, error } = await new Migrator({ db, provider: fileProvider(engineDir()) }).migrateToLatest();
  if (error) throw error;
  const ran = (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
  if (expected.gameId && expected.gameDir && migrationNames(expected.gameDir).length) { // the imeng's own tables, after the engine's, in a table of their own
    ran.push(...(await migrateGame(db, expected.gameId, expected.gameDir)));
  }
  if (expected.eligibility) await db.updateTable("eligibility").set({ mask: 0, version: expected.eligibility.version }).where("game", "=", expected.eligibility.game).where("version", "!=", expected.eligibility.version).execute();
  for (const [key, value] of [["rules", expected.rules], ["game", expected.game], ["proxy", expected.proxy]]) {
    await db.deleteFrom("stamp").where("key", "=", key).execute();
    await db.insertInto("stamp").values({ key, value }).execute();
  }
  return ran;
}

/** Apply one imeng's own migrations (its folder, its table); returns the names that ran, prefixed with the game id. */
export async function migrateGame(db: Db, gameId: string, dir: string): Promise<string[]> {
  const t = gameTable(gameId), g = await new Migrator({ db, provider: fileProvider(dir), migrationTableName: t, migrationLockTableName: `${t}_lock` }).migrateToLatest();
  if (g.error) throw g.error;
  return (g.results ?? []).filter((r) => r.status === "Success").map((r) => `${gameId}/${r.migrationName}`);
}

/** What the database holds: the migrations that ran (in order) and the stamp rows. Empty when the tables are not there yet. */
export async function readState(db: Db, gameId?: string): Promise<{ applied: string[]; appliedGame?: string[]; stamp: Record<string, string> }> {
  const tables = (await db.introspection.getTables({ withInternalKyselyTables: true })).map((t) => t.name);
  const applied = tables.includes("kysely_migration") ? (await db.selectFrom("kysely_migration").select("name").orderBy("name").execute()).map((r) => String(r.name)) : [];
  const stamp: Record<string, string> = {};
  if (tables.includes("stamp")) for (const r of await db.selectFrom("stamp").select(["key", "value"]).execute()) stamp[String(r.key)] = String(r.value);
  const gt = gameId ? gameTable(gameId) : "";
  const appliedGame = gt && tables.includes(gt) ? (await db.selectFrom(gt as never).select("name" as never).orderBy("name" as never).execute()).map((r: any) => String(r.name)) : gt ? [] : undefined;
  return { applied, appliedGame, stamp };
}
