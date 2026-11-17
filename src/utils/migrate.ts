import fs from "node:fs";
import path from "node:path";
import { runMigrations, CONFIG_SCHEMA_VERSION, type Cfg, type Migration } from "./migrations/index.js";

/** What `npm run migrate` does, apart from reading and writing files. Returns the text to print, the new file text and an exit code. */
export function migrateFile(text: string, to: number | undefined, list?: Migration[], current = CONFIG_SCHEMA_VERSION): { out: string[]; result?: string; from: number; target: number; code: number } {
  let cfg: Cfg;
  try { cfg = JSON.parse(text); } catch (e) { return { out: [`config.json is not valid JSON: ${(e as Error).message}`], from: 0, target: 0, code: 1 }; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { out: ["config.json must be a JSON object"], from: 0, target: 0, code: 1 };
  const from = typeof cfg.schema_version === "number" ? cfg.schema_version : 1;
  const target = to ?? current;
  const run = runMigrations(cfg, from, target, list);
  if (run.error) return { out: [run.error], from, target, code: 1 };
  if (run.direction === "none") return { out: [`Already at schema_version ${from}; nothing to do.`], from, target, code: 0 };
  const out = [`${run.direction === "up" ? "Migrating" : "Rolling back"} config.json from schema_version ${from} to ${target}:`];
  for (const m of run.steps) {
    out.push(`- ${run.direction === "up" ? `${m.from} -> ${m.to}` : `${m.to} -> ${m.from}`}: ${m.title}`);
    for (const n of run.direction === "up" ? m.notes : m.rollbackNotes) out.push(`    do by hand: ${n}`);
  }
  return { out, result: JSON.stringify(run.config, null, 2) + "\n", from, target, code: 0 };
}

/** `npm run migrate -- <game dir> [--to N] [--write]`: dry run unless --write (the old file is kept as config.json.bak-v<N>). */
export function main(argv: string[], list?: Migration[], current?: number): number {
  const args = argv.filter((a) => a !== "--write");
  const write = argv.includes("--write");
  const i = args.indexOf("--to");
  const to = i >= 0 ? Number(args[i + 1]) : undefined;
  if (i >= 0) args.splice(i, 2);
  const dir = args[0];
  if (!dir || (to !== undefined && !Number.isInteger(to))) { console.error("usage: npm run migrate -- <game dir> [--to N] [--write]"); return 2; }
  const file = path.join(dir, "config.json");
  if (!fs.existsSync(file)) { console.error(`no config.json in ${dir}` + (["config.mjs", "config.ts"].some((n) => fs.existsSync(path.join(dir, n))) ? ": a JS config is edited by hand, migrate only rewrites JSON" : "")); return 1; }
  const r = migrateFile(fs.readFileSync(file, "utf8"), to, list, current);
  for (const l of r.out) console.log(l);
  if (r.code || r.result === undefined) return r.code;
  if (!write) { console.log("\nDry run. Result:\n" + r.result + "Add --write to save it."); return 0; }
  fs.copyFileSync(file, `${file}.bak-v${r.from}`);
  fs.writeFileSync(file, r.result);
  console.log(`Wrote ${file} (old file kept as config.json.bak-v${r.from}). Now follow the notes above and run npm run doctor.`);
  return 0;
}
