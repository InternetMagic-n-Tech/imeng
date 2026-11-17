import { openDb } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { migrateUp, migrateGame, migrationNames, readState } from "./db-migrations.js";
import { expectedStamp } from "./db-state.js";
import { judgeState } from "./state-guard.js";
import { readGameFile } from "./game-file.js";
import { DATABASE_URL, IMENGS_ROOT } from "./config.js";

/** The imeng folders under `root` (also one level down, like a/b) that ship their own migrations: id = the model id in their config.json. */
export async function shippedGames(root: string): Promise<{ id: string; dir: string }[]> {
  const out: { id: string; dir: string }[] = [];
  const look = async (d: string, depth: number): Promise<void> => {
    try { const id = String(((await readGameFile(d)).raw as { model_id?: unknown })?.model_id ?? ""); if (id && migrationNames(path.join(d, "migrations")).length) out.push({ id, dir: path.join(d, "migrations") }); } catch { /* unreadable config: not a game */ }
    if (depth < 2) for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) if (e.isDirectory() && !/node_modules|^\./.test(e.name)) await look(path.join(d, e.name), depth + 1);
  };
  await look(root, 0);
  return out;
}

/** `npm run db:migrate [-- --status]`: apply the pending migrations and stamp the database, or only say where it stands. Returns the exit code. */
export async function dbMain(args: string[], url = DATABASE_URL, out: (m: string) => void = console.log): Promise<number> {
  if (!url) { out("DATABASE_URL is not set."); return 1; }
  const db = await openDb(url);
  try {
    const want = expectedStamp();
    if (args.includes("--status")) {
      const v = judgeState(await readState(db, want.gameId), want);
      out(v.ok ? "Database is up to date." : `${v.reason} (expected ${v.expected}, found ${v.found})`);
      return v.ok ? 0 : 1;
    }
    const ran = await migrateUp(db, want);
    if (args.includes("--all")) for (const g of (await shippedGames(IMENGS_ROOT)).filter((x) => x.id !== want.gameId)) ran.push(...(await migrateGame(db, g.id, g.dir))); // every imeng next to this one (the compose `migrate` service)
    out(ran.length ? `Applied: ${ran.join(", ")}` : "Nothing to apply.");
    return 0;
  } finally { await db.destroy(); }
}
