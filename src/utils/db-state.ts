import fs from "node:fs";
import { DATABASE_URL, STATE_PROBE_MS, STATE_EXIT, IMENG_PATH } from "./config.js";
import { config } from "./config.js";
import { openDb, type Db } from "./db.js";
import path from "node:path";
import { MIGRATION_NAMES, RULES_VERSION, migrationNames, type Expected } from "./db-migrations.js";
import { GAME_VERSION } from "./config.js";
import { StateGuard, type Verdict } from "./state-guard.js";
import { ELIGIBILITY, GAME_ID } from "./eligibility-config.js";
import { onShutdown } from "./shutdown.js";

/** The running instance's database handle and guard. Nothing exists (and every check passes) unless DATABASE_URL is set. */

const proxyVersion = (): string => { try { return String(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version); } catch { return ""; } };
/** This imeng's own migrations (imengs/<game>/migrations), when it has any. */
const gameMigrations = (): Pick<Expected, "gameId" | "gameDir" | "gameMigrations"> => { const gameDir = path.join(IMENG_PATH, "migrations"), names = migrationNames(gameDir); return names.length ? { gameId: GAME_ID, gameDir, gameMigrations: names } : {}; };
export const expectedStamp = (): Expected => ({ rules: ELIGIBILITY ? `${RULES_VERSION}.e${ELIGIBILITY.version}` : RULES_VERSION, eligibility: ELIGIBILITY ? { game: GAME_ID, version: ELIGIBILITY.version } : undefined, game: GAME_VERSION ?? "", proxy: proxyVersion(), migrations: MIGRATION_NAMES, ...gameMigrations() });

let db: Db | null = null;
let guard: StateGuard | null = null;

/** Open the database and start watching it. Returns the first verdict (not ok: the caller should not start). */
export async function startState(url = DATABASE_URL, opts: { exit?: (c: number) => void } = {}): Promise<Verdict> {
  if (!url) return { ok: true };
  db = await openDb(url);
  guard = new StateGuard({ db, expected: expectedStamp(), intervalMs: STATE_PROBE_MS, logOnly: !STATE_EXIT, exit: opts.exit });
  const first = await guard.check();
  guard.start();
  onShutdown(async () => { guard?.stop(); await db?.destroy(); });
  return first;
}

/** The cached verdict, for /healthz (never touches the database). */
export const stateVerdict = (): Verdict => guard?.verdict ?? { ok: true };
/** The verdict after a fresh look, for the start of a game turn. */
export const stateNow = async (): Promise<Verdict> => (guard ? guard.check() : { ok: true });
export const stateDb = (): Db | null => db;

export async function stopState(): Promise<void> { guard?.stop(); await db?.destroy(); db = null; guard = null; }

const st: any = config.state && typeof config.state === "object" ? config.state : null;
export const unavailableText = (): string => (typeof st?.texts?.unavailable === "string" ? st.texts.unavailable : "This game is temporarily unavailable. Try again in a moment.");
