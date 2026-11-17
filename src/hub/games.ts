import path from "node:path";
import { gameFolders, readGameFile } from "../utils/game-file.js";

export interface HubGame {
  dir: string;
  modelId: string;
  /** Folder name under the hub's SAVE_DIR: the path below the imengs root with "/" as "-" (imengs/a/b -> a-b). */
  slug: string;
  /** imeng.json `icon` (a file name in the game folder), when set. */
  icon?: string;
}

type Reader = (dir: string) => Promise<{ raw: unknown }>;

/** Every game under `root` that has a model_id. `skip` lists model ids to leave out. Problems are reported, never thrown: one broken game must not hide the others. */
export async function discoverGames(root: string, skip: string[] = [], read: Reader = readGameFile): Promise<{ games: HubGame[]; problems: string[] }> {
  const games: HubGame[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const dir of gameFolders(root)) {
    const rel = path.relative(root, dir) || path.basename(dir);
    let id = "", icon: string | undefined;
    try {
      const raw = (await read(dir)).raw as { model_id?: unknown; icon?: unknown } | null;
      id = typeof raw?.model_id === "string" ? raw.model_id.trim() : "";
      icon = typeof raw?.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined;
    } catch (e) { problems.push(`${rel}: ${(e as Error).message}`); continue; }
    if (!id) { problems.push(`${rel}: no model_id, left out`); continue; }
    if (skip.includes(id)) continue;
    if (seen.has(id)) { problems.push(`${rel}: model_id "${id}" is already used by another game, left out`); continue; }
    seen.add(id);
    games.push({ dir, modelId: id, slug: rel.split(path.sep).join("-"), ...(icon ? { icon } : {}) });
  }
  return { games, problems };
}
