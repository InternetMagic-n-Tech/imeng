import path from "node:path";
import type { Finding, Sys, Settings } from "./doctor.js";

/** Doctor checks for `seating.photo` (the seat picture) and `seating.start`. Nothing is reported without them. */
const f = (level: Finding["level"], id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level, title, detail, fix });

export async function checkSeating({ sys, s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  const seating = (s.game as { seating?: any }).seating, p = seating?.photo;
  if (!seating) return [];
  const out: Finding[] = [];
  if (seating.start && !(s.game as { phases?: Record<string, any> }).phases) out.push(f("info", "seat-start-phase", "seating.start needs a phase to wait in", "The show's registration phase should require game.started so nothing begins before /start or full seats.", "Add {field: \"game.started\", is: true} to phases.<registration>.require."));
  if (!p) return out;
  const c = p.check ?? {};
  const vision = (s.game as { vision?: unknown }).vision;
  if (!c.url && !vision) { out.push(f("fail", "seat-photo-check", "seating.photo needs a checker", "Without the vision module or check.url no seat can be taken (the check fails closed).", "Add a vision block (see src/tools/vision/README.md), or set check.url to a local HTTP service.")); return out; }
  out.push(c.url ? f("info", "seat-photo-check", `Seat pictures are checked by ${c.url}`, "A local service that answers {people:[{score, keypoints:[[x,y,confidence] x 17]}]} to a POST of the picture.") : f("ok", "seat-photo-check", "Seat pictures are checked by the vision module (pose)"));
  if (p.show !== false && !(s.game as { images?: unknown }).images) out.push(f("warn", "seat-photo-serve", "Seat photos cannot be shown to the table", "Pictures are served from /images, which only exists when the imeng has an images block.", "Add an images block, or set seating.photo.show to false."));
  if (typeof p.text_file === "string" && p.text_file && !sys.readFile(path.join(s.gameDir, p.text_file))) out.push(f("warn", "seat-photo-text", `seating.photo.text_file ${p.text_file} was not found`, "The default rules text is sent instead.", "Create the markdown file in the game folder."));
  if (!(s.game as { images?: { safety?: unknown } }).images?.safety) out.push(f("info", "seat-photo-safety", "Seat pictures are not checked for nudity", "Add images.safety so a safe-for-work check runs on every seat picture too."));
  return out;
}
