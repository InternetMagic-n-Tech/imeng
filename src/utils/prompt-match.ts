import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/*
 * Is this the same prompt as a stored one? Compared with HTML comments removed, punctuation dropped and white space collapsed, so a
 * prompt pasted with different line breaks or a stray comma still matches. `unifiedDiff` shows what differs, using the system `diff`.
 */

export function normalizePrompt(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}
export const promptHash = (text: string): string => crypto.createHash("sha1").update(normalizePrompt(text)).digest("hex");
export const samePrompt = (a: string, b: string): boolean => promptHash(a) === promptHash(b);

export interface Version { version: number; text?: string }

/** The newest stored version whose text matches, or null. */
export function matchVersion(text: string, versions: Version[]): Version | null {
  const h = promptHash(text);
  return [...versions].sort((a, b) => b.version - a.version).find((v) => typeof v.text === "string" && promptHash(v.text) === h) ?? null;
}

/** A unified diff of two prompts, one normalised word per line so only real wording shows. Empty when they match; null when `diff` is not installed. */
export function unifiedDiff(a: string, b: string, run: typeof spawnSync = spawnSync): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdiff-"));
  try {
    const [fa, fb] = ["stored", "current"].map((n) => path.join(dir, n));
    fs.writeFileSync(fa, normalizePrompt(a).split(" ").join("\n") + "\n");
    fs.writeFileSync(fb, normalizePrompt(b).split(" ").join("\n") + "\n");
    const r = run("diff", ["-u", fa, fb], { encoding: "utf8" });
    if (r.error) return null;
    return String(r.stdout ?? "").replace(/^(---|\+\+\+) .*$/gm, (l) => l.slice(0, 3));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
