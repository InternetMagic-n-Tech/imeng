import fs from "node:fs";
import path from "node:path";
import { renderTemplate } from "./md-template.js";
import { extractImages, convertWithSharp } from "./md-assets.js";
import type { Convert } from "./md-assets.js";

/*
 * A game's build step. `X.template.md` is rendered to `X.md` when the output is missing or older than any file it reads (or with force).
 * Then every markdown file in the game folder has its inline images moved to `assets/`. A game with neither is left alone.
 */

export interface BuildOpts { force?: boolean; convert?: Convert; log?: (line: string) => void }
export interface BuildReport { built: string[]; skipped: string[]; images: { file: string; saved: string[]; before: number; after: number }[] }

const TEMPLATE = /\.template\.md$/;
const SKIP_DIRS = new Set(["node_modules", "assets", "saves", ".git"]);

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...markdownFiles(p)); }
    else if (e.name.endsWith(".md") && !TEMPLATE.test(e.name)) out.push(p);
  }
  return out;
}
const mtime = (f: string): number => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

export async function buildGame(dir: string, opts: BuildOpts = {}): Promise<BuildReport> {
  const log = opts.log ?? (() => {});
  const rep: BuildReport = { built: [], skipped: [], images: [] };
  if (!fs.existsSync(dir)) throw new Error(`game folder not found: ${dir}`);
  const templates = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && TEMPLATE.test(e.name)).map((e) => path.join(e.parentPath, e.name)).filter((f) => !f.split(path.sep).some((x) => SKIP_DIRS.has(x)));
  for (const t of templates) {
    const out = t.replace(TEMPLATE, ".md");
    const t0 = Date.now();
    const { text, files } = renderTemplate(t);
    if (!opts.force && fs.existsSync(out) && Math.max(...files.map(mtime)) <= mtime(out)) { rep.skipped.push(out); continue; }
    fs.writeFileSync(out, text);
    rep.built.push(out);
    log(`built ${path.relative(dir, out)} from ${files.length} file(s) in ${Date.now() - t0}ms`);
  }
  for (const f of markdownFiles(dir)) {
    const src = fs.readFileSync(f, "utf8");
    if (!/data:image\//.test(src)) continue;
    const t0 = Date.now();
    const r = await extractImages(src, path.dirname(f), opts.convert ?? convertWithSharp);
    if (r.text === src) continue;
    fs.writeFileSync(f, r.text);
    rep.images.push({ file: f, saved: r.saved, before: r.before, after: r.after });
    log(`images in ${path.relative(dir, f)}: ${r.before} -> ${r.after} bytes, ${r.saved.length} file(s) in ${Date.now() - t0}ms`);
  }
  return rep;
}
