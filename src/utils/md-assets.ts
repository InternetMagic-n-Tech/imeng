import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/*
 * Inline images (`data:image/...;base64,...`) make a markdown file huge. They are decoded, optimised, saved in an `assets` folder
 * next to the file under a name taken from their content, and replaced by an ordinary markdown image tag.
 */

export interface Converted { bytes: Buffer; ext: string }
export type Convert = (bytes: Buffer, mime: string) => Promise<Converted>;
export interface AssetResult { text: string; saved: string[]; before: number; after: number }

const MD_IMAGE = /!\[([^\]]*)\]\(\s*data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)\s*(?:"[^"]*")?\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc=["']data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)["'][^>]*>/gi;
const REF_DEF = /^(\s*\[[^\]]+\]:\s*)data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)[ \t]*$/gm;

const ext = (mime: string): string => (mime.startsWith("svg") ? "svg" : mime === "jpeg" ? "jpg" : mime.replace(/\W.*$/, "") || "bin");

/** Raster images become WebP when that is smaller; SVG and anything sharp cannot read are kept as they came. */
export const convertWithSharp: Convert = async (bytes, mime) => {
  const keep = { bytes, ext: ext(mime) };
  if (mime.startsWith("svg")) return keep;
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(bytes, { animated: mime === "gif" }).webp({ quality: 82, effort: 5 }).toBuffer();
    return out.length < bytes.length ? { bytes: out, ext: "webp" } : keep;
  } catch { return keep; }
};

const altOf = (s: string): string => s.replace(/[[\]]/g, "").trim();

/** Extract the inline images of one markdown text. `dir` is the folder the markdown file lives in; images go to `dir/assets`. */
export async function extractImages(text: string, dir: string, convert: Convert = convertWithSharp): Promise<AssetResult> {
  const found: { whole: string; mime: string; data: string; alt: string; prefix: string }[] = [];
  text.replace(MD_IMAGE, (whole, alt, mime, data) => { found.push({ whole, mime, data, alt: altOf(alt), prefix: "" }); return whole; });
  text.replace(HTML_IMAGE, (whole, mime, data) => { found.push({ whole, mime, data, alt: altOf(/\balt=["']([^"']*)["']/i.exec(whole)?.[1] ?? ""), prefix: "" }); return whole; });
  text.replace(REF_DEF, (whole, prefix, mime, data) => { found.push({ whole, mime, data, alt: "", prefix }); return whole; });
  const saved: string[] = [];
  let out = text;
  const names = new Map<string, string>();
  for (const f of found) {
    let name = names.get(f.whole);
    if (!name) {
      const raw = Buffer.from(f.data.replace(/\s+/g, ""), "base64");
      const c = await convert(raw, f.mime.toLowerCase());
      name = `${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12)}.${c.ext}`;
      const file = path.join(dir, "assets", name);
      if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, c.bytes); }
      names.set(f.whole, name); if (!saved.includes(name)) saved.push(name);
    }
    out = out.split(f.whole).join(f.prefix ? `${f.prefix}assets/${name}` : `![${f.alt}](assets/${name})`);
  }
  return { text: out, saved, before: Buffer.byteLength(text), after: Buffer.byteLength(out) };
}
