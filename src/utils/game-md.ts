import fs from "node:fs";
import path from "node:path";
import { IMENG_PATH } from "./config.js";

/** A markdown file from the imeng folder (the game's own words: seat rules, terms), confined to that folder and capped. "" when it is missing or outside the folder. */
export function readGameMd(rel: string, cap = 4000): string {
  if (!rel) return "";
  try {
    const root = path.resolve(IMENG_PATH), p = path.resolve(root, rel);
    return p.startsWith(root + path.sep) ? fs.readFileSync(p, "utf8").trim().slice(0, cap) : "";
  } catch { return ""; }
}
