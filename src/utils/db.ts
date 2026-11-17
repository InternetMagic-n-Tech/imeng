import { Kysely, PostgresDialect, SqliteDialect } from "kysely";

/** One Kysely handle for the bookkeeping database: Postgres (`postgres://...`, Docker) or SQLite (`sqlite::memory:` / `sqlite:<file>`, tests and --no-persist). */
export type Db = Kysely<any>;

export async function openDb(url: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const { default: pg } = await import("pg");
    return new Kysely<any>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX || 5) }) }) });
  }
  const m = /^sqlite:(.*)$/i.exec(url);
  if (!m) throw new Error(`DATABASE_URL must start with postgres:// or sqlite: (got "${url.slice(0, 12)}...")`);
  const { default: Sqlite } = await import("better-sqlite3");
  const file = m[1] === ":memory:" || m[1] === "" ? ":memory:" : m[1];
  return new Kysely<any>({ dialect: new SqliteDialect({ database: new Sqlite(file) }) });
}
