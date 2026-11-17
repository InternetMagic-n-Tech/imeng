import fs from "node:fs";
import path from "node:path";

/**
 * Where a game's settings live. In order: `config.mjs` (an ES module whose default export is the settings object, or a function returning it, sync or async),
 * `config.ts` (the same, for when the code runs under vite-node or the tests; a built server cannot import TypeScript, so ship `.mjs` or `.json`), then `config.json`.
 * JS lets a game keep comments, build from shared pieces and switch parts on and off. The settings are checked the same way whichever file they come from.
 */
export const GAME_FILES = ["config.mjs", "config.ts", "config.json"] as const;

export const gameFileOf = (dir: string, exists: (p: string) => boolean = fs.existsSync): string | null => {
  for (const n of GAME_FILES) { const f = path.join(dir, n); if (exists(f)) return f; }
  return null;
};

/** The raw settings of the game in `dir` ({} when it has none), and the file they came from. Throws with the file name when it cannot be read. */
export async function readGameFile(dir: string): Promise<{ raw: unknown; file: string | null }> {
  const file = gameFileOf(dir);
  if (!file) return { raw: {}, file: null };
  try {
    if (file.endsWith(".json")) return { raw: JSON.parse(fs.readFileSync(file, "utf8") || "{}"), file };
    const mod = await import(/* @vite-ignore */ path.resolve(file));
    const def = (mod as { default?: unknown }).default;
    return { raw: typeof def === "function" ? await (def as () => unknown)() : def ?? {}, file };
  } catch (e) { throw new Error(`${path.basename(file)} could not be read: ${(e as Error).message}`); }
}

/** Every game folder under `root` (a folder with config.mjs, config.ts or config.json), at any depth: a nested game counts, a folder that only holds games does not. */
export function gameFolders(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (gameFileOf(dir)) { out.push(dir); return; }
    for (const e of entries) if (e.isDirectory() && !["node_modules", "assets", "saves", "cases", "prompts", "src", "dist", "scripts", "coverage"].includes(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name));
  };
  walk(root);
  return out.sort();
}
