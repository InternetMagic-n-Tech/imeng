import path from "node:path";
import { GiB, isProblem } from "./doctor.js";
import type { Finding, Report } from "./doctor.js";

export interface FormatOptions {
  color?: boolean;
  /** Only warnings and failures (plus the summary). */
  onlyProblems?: boolean;
  /** Game directory shown in the header. */
  gameDir?: string;
}

/** Human-readable report lines, shared by `npm run doctor` and the server's --preflight. */
export function formatReport(report: Report, { color = false, onlyProblems = false, gameDir = "" }: FormatOptions = {}): string[] {
  const paint = (code: string, t: string) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const icon: Record<Finding["level"], string> = { ok: paint("32", "✓"), info: paint("36", "i"), warn: paint("33", "⚠"), fail: paint("31", "✗") };
  const hw = report.hardware;
  const lines: string[] = [];

  lines.push(paint("1", `\nGame proxy doctor${gameDir ? `: ${path.basename(gameDir)}` : ""} on ${hw.platform}/${hw.arch}, ${(hw.ramTotal / GiB).toFixed(0)} GiB RAM${hw.gpus[0] ? `, ${hw.gpus[0].name}` : ""}\n`));
  for (const f of report.findings) {
    if (onlyProblems && !isProblem(f)) continue;
    lines.push(`${icon[f.level]} ${f.title}`);
    if (f.detail) lines.push(`    ${f.detail}`);
    if (f.fix) lines.push(paint("2", `    → ${f.fix}`));
  }
  if (report.suggestion) {
    lines.push(paint("1", `\nSuggested Ollama start (context ${report.suggestion.contextLength}):`));
    lines.push(`  ${report.suggestion.command}`);
  }
  const count = (l: Finding["level"]) => report.findings.filter((f) => f.level === l).length;
  lines.push(`\n${count("ok")} ok, ${count("info")} info, ${count("warn")} warning(s), ${count("fail")} failure(s)${report.bailed ? " (stopped early: --bail)" : ""}`);
  return lines;
}
