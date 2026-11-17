import { openDb, type Db } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { DATABASE_URL } from "./config.js";
import { bucketRemove } from "./bucket.js";

/** Every row has an expiry. Removes the rows whose `expires_at` (milliseconds since the epoch) has passed, from every table that has the column. Returns the count per table. */
export async function cleanExpired(db: Db, now = Date.now()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // Expired attachments: the file goes first (bucket object and any staged copy), then the row. A row whose object could not be deleted stays, so the next run tries again.
  const tables = await db.introspection.getTables();
  if (tables.some((t) => t.name === "attachments")) {
    const rows = await db.selectFrom("attachments").select(["session", "id", "bucket_key"]).where("expires_at", "<=", now).execute();
    let kept = 0;
    for (const r of rows as { session: string; id: string; bucket_key: string | null }[]) {
      if (r.bucket_key && !(await bucketRemove(r.bucket_key))) { kept++; continue; }
      try { fs.rmSync(path.join(path.resolve(process.env.ATTACH_CACHE_DIR || "./_cache"), `${r.session.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "none"}-${r.id}`), { force: true }); } catch { /* a staged copy that is already gone */ }
      await db.deleteFrom("attachments").where("session", "=", r.session).where("id", "=", r.id).execute();
    }
    out.attachments = rows.length - kept;
  }
  for (const t of tables) {
    if (t.name === "attachments") continue;
    if (!t.columns.some((c) => c.name === "expires_at")) continue;
    const r = await db.deleteFrom(t.name).where("expires_at", "<=", now).executeTakeFirst();
    out[t.name] = Number(r.numDeletedRows ?? 0);
  }
  return out;
}

/** `npm run db:cleanup [-- --every <ms>]`: once, or on a timer (the compose `cleanup` service). `stop` ends a timed run (tests). */
export async function cleanupMain(args: string[], url = DATABASE_URL, out: (m: string) => void = console.log, stop?: AbortSignal): Promise<number> {
  if (!url) { out("DATABASE_URL is not set."); return 1; }
  const i = args.indexOf("--every");
  const every = i >= 0 ? Math.max(1000, Number(args[i + 1]) || 0) : Number(process.env.CLEANUP_EVERY_MS || 0);
  const db = await openDb(url);
  try {
    do {
      const t0 = Date.now();
      const counts = await cleanExpired(db);
      console.log(`[cleanup] ${Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(", ") || "no tables with expiry"} in ${Date.now() - t0} ms`);
      out(JSON.stringify(counts));
      if (every && !stop?.aborted) await new Promise<void>((r) => { const t = setTimeout(r, every); stop?.addEventListener("abort", () => { clearTimeout(t); r(); }); });
    } while (every && !stop?.aborted);
    return 0;
  } finally { await db.destroy(); }
}
