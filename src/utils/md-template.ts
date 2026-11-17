import fs from "node:fs";
import path from "node:path";

/*
 * Markdown templates: a link to another .md file, `[text](file.md)` (images and URLs excluded), is replaced by that file's text.
 * Each imported file is cleaned first: HTML comments are removed (the blank space around one becomes the average of the space above
 * and below it), imports inside it are resolved, and its edges are trimmed so it adds no line breaks around the link.
 */

const COMMENT = /<!--[\s\S]*?-->(?:\s*<!--[\s\S]*?-->)*/g; // a run of comments counts as one
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+\.md)\)/g;

const newlines = (s: string): number => (s.match(/\n/g) ?? []).length;

/** Remove HTML comments. The blank space on both sides of a comment becomes one gap: the average line breaks of the two sides (at the start or end of the text, the one side that exists). */
export function stripComments(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(COMMENT)) {
    const start = m.index!;
    const head = text.slice(last, start);
    const before = /\s*$/.exec(head)![0];
    const afterFrom = start + m[0].length;
    const after = /^\s*/.exec(text.slice(afterFrom))![0];
    const atStart = out === "" && head.trim() === "";
    const atEnd = afterFrom + after.length >= text.length;
    const a = atStart ? newlines(after) : newlines(before);
    const b = atEnd ? newlines(before) : newlines(after);
    const breaks = Math.round((a + b) / 2);
    const gap = breaks > 0 ? "\n".repeat(breaks) : before || after ? " " : "";
    out += text.slice(last, start - before.length) + gap;
    last = afterFrom + after.length;
  }
  return out + text.slice(last);
}

export interface TemplateIO { read?: (file: string) => string | null }
export interface Built { text: string; files: string[] }

const defaultRead = (file: string): string | null => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

/** Resolve a markdown file's links to other markdown files. `files` lists every file read (for "is the output out of date"). A link to a missing file, or back into a file being resolved, is left as written. */
export function renderTemplate(file: string, io: TemplateIO = {}): Built {
  const read = io.read ?? defaultRead;
  const files: string[] = [];
  const walk = (f: string, stack: string[]): string | null => {
    const raw = read(f);
    if (raw === null) return null;
    if (!files.includes(f)) files.push(f);
    const clean = stripComments(raw);
    const dir = path.dirname(f);
    return clean.replace(LINK, (whole, rel: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return whole;
      const target = path.join(dir, rel);
      if (stack.includes(target)) return whole;
      const inner = walk(target, [...stack, f]);
      return inner === null ? whole : inner.trim();
    });
  };
  const text = walk(file, [file]);
  if (text === null) throw new Error(`template not found: ${file}`);
  return { text: text.trim() + "\n", files };
}
