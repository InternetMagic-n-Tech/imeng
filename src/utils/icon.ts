import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";

/** A game's picture (imeng.json `icon`): a small image file in the game folder, served at /icons/<model_id> so Open WebUI can be pointed at it. Never imports config.ts (the hub uses it). */
export const ICON_MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** Why `name` cannot be an icon file name, or null when it can. */
export function iconNameProblem(name: string): string | null {
  if (!name || name !== path.basename(name) || name.startsWith(".")) return "must be a file name in the game folder (no folders)";
  return TYPES[path.extname(name).toLowerCase()] ? null : "must be a png, jpg, webp or gif file";
}

export interface Icon { bytes: Buffer; type: string }

/** The icon's bytes, or null when the name is not allowed, the file is missing, is a symlink out of the folder, or is over ICON_MAX_BYTES. */
export function readIcon(dir: string, name: string | undefined): Icon | null {
  if (!name || iconNameProblem(name)) return null;
  try {
    const root = fs.realpathSync(dir), real = fs.realpathSync(path.join(dir, name));
    if (!real.startsWith(root + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > ICON_MAX_BYTES) return null;
    return { bytes: fs.readFileSync(real), type: TYPES[path.extname(name).toLowerCase()] };
  } catch { return null; }
}

export function sendIcon(res: Response, icon: Icon | null): void {
  if (!icon) { res.status(404).end(); return; }
  res.set("Content-Type", icon.type).set("Cache-Control", "public, max-age=3600").set("X-Content-Type-Options", "nosniff").send(icon.bytes);
}

export const iconUrl = (publicUrl: string, modelId: string): string => `${publicUrl.replace(/\/+$/, "")}/icons/${encodeURIComponent(modelId)}`;
