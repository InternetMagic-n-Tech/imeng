import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSION_PREFIX } from "./config.js";
import { allDocs, clearAll, loadDoc, saveDoc } from "./store.js";

/**
 * Move sessions between Redis and plain files (npm run sessions). The files are exactly what `npm start` keeps in SAVE_DIR (one pretty-printed JSON
 * per session, named by the hash of the session key), so you can open one to see what Redis holds, edit it, and load it back, or point
 * SAVE_DIR at an exported folder and run the proxy in file mode on the same game. `prefix` is the game's Redis prefix (default imeng:<model_id>).
 */

const fileName = (key: string): string => crypto.createHash("sha1").update(key).digest("hex") + ".json";

export interface Listed { key: string; version: number; turns: number; mode?: string }

export async function listSessions(prefix = SESSION_PREFIX): Promise<Listed[]> {
  const out: Listed[] = [];
  for await (const d of allDocs(prefix)) {
    try { const j = JSON.parse(d.body); out.push({ key: j.key, version: d.version, turns: Math.max(0, (j.snapshots?.length ?? 1) - 1), mode: j.mode }); }
    catch { out.push({ key: `(unreadable ${d.hash})`, version: d.version, turns: 0 }); }
  }
  return out;
}

/** Write every session of the game to `dir` as pretty JSON. Returns how many. */
export async function exportSessions(dir: string, prefix = SESSION_PREFIX): Promise<number> {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for await (const d of allDocs(prefix)) {
    let json: any;
    try { json = JSON.parse(d.body); } catch { console.warn(`skipping unreadable session ${d.hash}`); continue; }
    fs.writeFileSync(path.join(dir, fileName(json.key)), JSON.stringify(json, null, 2) + "\n");
    n++;
  }
  return n;
}

/** Load every *.json in `dir` into Redis (replacing the session with the same key). Returns how many; bad files are skipped with a message. */
export async function importSessions(dir: string, prefix = SESSION_PREFIX): Promise<number> {
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (typeof j.key !== "string" || !Array.isArray(j.snapshots)) throw new Error("not a saved session (needs key and snapshots)");
      const cur = await loadDoc(j.key, prefix);
      const r = await saveDoc(j.key, JSON.stringify(j), cur?.version ?? 0, prefix);
      if (!r.ok) throw new Error("changed by someone else while importing; run it again");
      n++;
    } catch (e) { console.warn(`skipping ${f}: ${(e as Error).message}`); }
  }
  return n;
}

/** Remove every session of the game from Redis. Returns how many keys went. */
export const clearSessions = (prefix = SESSION_PREFIX): Promise<number> => clearAll(prefix);
