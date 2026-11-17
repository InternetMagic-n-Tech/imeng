import path from "node:path";
import type { Finding, Sys, Settings } from "./doctor.js";

/** Doctor check for the `terms` setting: the markdown file must exist in the game folder. Nothing is reported without the setting. */
export async function checkTerms({ sys, s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  const t = (s.game as { terms?: { file?: string } }).terms;
  if (!t) return [];
  const file = typeof t.file === "string" ? t.file : "";
  if (!file) return [{ id: "terms-file", level: "fail", title: "terms needs a file", detail: "The setting is on but names no markdown file.", fix: "Set terms.file to a file in the game folder." }];
  const text = sys.readFile(path.join(s.gameDir, file));
  if (!text) return [{ id: "terms-file", level: "fail", title: `The terms file ${file} was not found or is empty`, detail: "Nobody is sent terms until it exists.", fix: "Write it in the game folder." }];
  return [{ id: "terms-file", level: "ok", title: `Terms (${file}) are sent once to each person when they are seated` }];
}
