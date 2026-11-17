import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Secrets and endpoints for tools: keys, URLs, providers. They live in a file you keep out of git (tools.config.mjs; start from
 * tools.config.example.mjs), not in config.json (which is shared and committed) and not in environment variables (one file is easier to manage
 * for several tools). The file default-exports an object keyed by tool name; TOOLS_CONFIG points at another path; a .json file works too.
 */
let cached: Promise<Record<string, any>> | null = null;

export function toolsConfigPath(): string { return path.resolve(process.env.TOOLS_CONFIG || "tools.config.mjs"); }

export function toolsConfig(): Promise<Record<string, any>> {
  cached ??= (async () => {
    const file = toolsConfigPath();
    if (!fs.existsSync(file)) return {};
    try {
      const j = file.endsWith(".json") ? JSON.parse(fs.readFileSync(file, "utf8")) : (await import(/* @vite-ignore */ pathToFileURL(file).href)).default;
      return j && typeof j === "object" ? j : {};
    } catch (e) { console.warn(`could not read ${file}:`, (e as Error).message); return {}; }
  })();
  return cached;
}

/** Tests: read the file again next time. */
export function _resetToolsConfig(): void { cached = null; }
