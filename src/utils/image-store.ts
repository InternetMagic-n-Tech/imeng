import fs from "node:fs";
import { bucketPut } from "./bucket.js";
import path from "node:path";
import crypto from "node:crypto";
import { IMAGE_DIR, PUBLIC_URL, IMAGE_MAX_BYTES } from "./image-config.js";
import { sniff, usable, extOf, mimeOf } from "./image-format.js";
import type { ImageKind } from "./image-format.js";

/** Pictures on disk, named by their content, served from /images/<name> (the name is the only secret: it cannot be guessed). */

export class BadImage extends Error { constructor(readonly kind: ImageKind | "too_big") { super(`not a usable image: ${kind}`); } }

const NAME = /^[a-f0-9]{24}\.(png|jpg|webp)$/;

export function saveImage(bytes: Uint8Array, dir = IMAGE_DIR): string {
  if (bytes.length > IMAGE_MAX_BYTES) throw new BadImage("too_big");
  const kind = sniff(bytes);
  if (!usable(kind)) throw new BadImage(kind);
  const name = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 24) + "." + extOf(kind);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  void bucketPut(`images/${name}`, bytes, mimeOf(kind)); // a copy in the bucket when there is one (best effort)
  return name;
}

export const urlOf = (name: string): string => `${PUBLIC_URL}/images/${name}`;

/** Delete a stored picture by name (names that are not ours are ignored). The bucket copy, when there is one, is left to its own expiry. */
export function removeImage(name: string, dir = IMAGE_DIR): boolean {
  if (!NAME.test(name)) return false;
  try { fs.rmSync(path.join(dir, name), { force: true }); return true; } catch { return false; }
}

/** A stored picture's bytes and content type, or null for a name that is not one of ours. */
export function readImage(name: string, dir = IMAGE_DIR): { bytes: Buffer; type: string } | null {
  if (!NAME.test(name)) return null;
  try {
    const bytes = fs.readFileSync(path.join(dir, name));
    return { bytes, type: mimeOf(sniff(bytes)) };
  } catch { return null; }
}
