/*
 * Models to compare against the main one. COMPARE_MODELS is a JSON array or a comma list; a flag passed as `list` wins over it.
 * `prefer` (COMPARE_PREFER, or the flag; 1-based) forces one of them, so a run uses exactly that model; without it all of them run.
 */

export function parseList(v: string | undefined): string[] {
  const s = (v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean); } catch { /* a comma list that starts with [ */ } }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export interface Pick { models: string[]; forced: boolean; note?: string }

export function pickCompare(opts: { list?: string[]; prefer?: number | string; env?: NodeJS.ProcessEnv } = {}): Pick {
  const env = opts.env ?? process.env;
  const all = opts.list?.length ? opts.list : parseList(env.COMPARE_MODELS);
  const raw = opts.prefer ?? env.COMPARE_PREFER;
  if (raw === undefined || raw === "") return { models: all, forced: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > all.length) return { models: all, forced: false, note: `compare model ${raw} is not one of the ${all.length} available; running all` };
  return { models: [all[n - 1]], forced: true };
}
