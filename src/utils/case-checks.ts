import type { Check } from "./case-file.js";

export interface Outcome { line: string; ok: boolean; detail: string }

export const read = (obj: unknown, p: string): unknown => p.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

export function compare(op: string, got: unknown, want: unknown): boolean {
  switch (op) {
    case "present": return got !== undefined && got !== null;
    case "==": return JSON.stringify(got) === JSON.stringify(want) || String(got) === String(want);
    case "!=": return !compare("==", got, want);
    case "contains": return Array.isArray(got) ? got.some((x) => JSON.stringify(x) === JSON.stringify(want) || String(x) === String(want)) : String(got ?? "").includes(String(want));
    default: { const a = Number(got), b = Number(want); if (!Number.isFinite(a) || !Number.isFinite(b)) return false; return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b; }
  }
}

/** Run the checks that need no model: state values and reply text. Judge lines come back undecided (null). */
export function runChecks(checks: Check[], state: unknown, replies: string[]): (Outcome | null)[] {
  return checks.map((c): Outcome | null => {
    if (c.kind === "judge") return null;
    if (c.kind === "state") { const got = read(state, c.path); return { line: c.line, ok: compare(c.op, got, c.value), detail: `${c.path} is ${JSON.stringify(got)}` }; }
    const pool = c.scope === "last" ? replies.slice(-1) : replies;
    const hit = (r: string): boolean => (c.op === "matches" ? new RegExp(c.value.replace(/^\/(.*)\/[a-z]*$/s, "$1"), c.value.match(/^\/.*\/([a-z]*)$/s)?.[1] || "i").test(r) : r.toLowerCase().includes(c.value.toLowerCase()));
    const any = pool.some(hit);
    return { line: c.line, ok: c.op === "not contains" ? !any : any, detail: `${pool.length} repl${pool.length === 1 ? "y" : "ies"} checked` };
  });
}
