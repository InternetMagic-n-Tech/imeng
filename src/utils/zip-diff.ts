import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

/*
 * A zip of what changed since the last zip. The last zip's file hashes are kept in `<src>/.zip-state.json`; a file is packed when it is new
 * or its hash differs, and removed files are listed in ZIP-DELETED.txt inside the zip. With no state yet, `since` (a zip file or a date)
 * stands in for it: files modified after that moment are packed. Nothing is packed when nothing changed.
 */

const STATE = ".zip-state.json";
const SKIP = new Set(["node_modules", "dist", "coverage", "saves", "logs", ".git", "docker"]);
const SKIP_FILES = [/\.zip$/, /^\.env$/, new RegExp(`^${STATE.replace(".", "\\.")}$`), /\.log$/, /\.tmp$/];

export interface ZipOpts { src: string; out?: string; all?: boolean; since?: string; run?: (out: string, files: string[], cwd: string) => Promise<void> }
export interface ZipResult { out: string; files: string[]; deleted: string[] }

const sha = (f: string): string => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");

export function listFiles(src: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) out.push(...listFiles(src, r)); }
    else if (e.isFile() && !SKIP_FILES.some((x) => x.test(e.name))) out.push(r);
  }
  return out.sort();
}

const sinceMs = (s: string): number => (fs.existsSync(s) ? fs.statSync(s).mtimeMs : Date.parse(s));

const zipWith = (out: string, files: string[], cwd: string): Promise<void> => new Promise((resolve, reject) => {
  const p = spawn("zip", ["-q", "-@", out], { cwd });
  p.on("error", reject);
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`zip exited ${c}`))));
  p.stdin.end(files.join("\n") + "\n");
});

function nextName(src: string): string {
  const base = path.basename(path.resolve(src));
  const dir = path.dirname(path.resolve(src));
  let n = 1;
  while (fs.existsSync(path.join(dir, `${base}-changes-${n}.zip`))) n++;
  return path.join(dir, `${base}-changes-${n}.zip`);
}

export async function zipSinceLast(o: ZipOpts): Promise<ZipResult> {
  const src = path.resolve(o.src);
  const all = listFiles(src);
  const stateFile = path.join(src, STATE);
  const prev: Record<string, string> | null = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
  const now: Record<string, string> = Object.fromEntries(all.map((f) => [f, sha(path.join(src, f))]));
  let files = all;
  let deleted: string[] = [];
  if (!o.all) {
    if (prev) { files = all.filter((f) => prev[f] !== now[f]); deleted = Object.keys(prev).filter((f) => !(f in now)); }
    else if (o.since) { const t = sinceMs(o.since); if (!Number.isFinite(t)) throw new Error(`--since: not a file or a date: ${o.since}`); files = all.filter((f) => fs.statSync(path.join(src, f)).mtimeMs > t); }
  }
  const out = path.resolve(o.out ?? nextName(src));
  if (!files.length && !deleted.length) return { out, files: [], deleted: [] };
  const list = [...files];
  const marker = path.join(src, "ZIP-DELETED.txt");
  if (deleted.length) { fs.writeFileSync(marker, deleted.join("\n") + "\n"); list.push("ZIP-DELETED.txt"); }
  try { fs.rmSync(out, { force: true }); await (o.run ?? zipWith)(out, list, src); }
  finally { if (deleted.length) fs.rmSync(marker, { force: true }); }
  fs.writeFileSync(stateFile, JSON.stringify(now, null, 1) + "\n");
  return { out, files, deleted };
}
