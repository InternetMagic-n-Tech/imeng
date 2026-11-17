import { IMAGECENSOR_LABELS } from "./image-labels.js";
import { IMAGES } from "./image-config.js";
import { visionCensor, type Hit } from "./vision.js";

/**
 * Content check for pictures (config.json `images.safety`, off when absent): the vision module's image censor (a host-only Python worker, config.json `vision`) reports what it
 * sees; code decides: a label in `labels` at or over `threshold` blocks the picture. Fails closed (SafetyUnavailable) when the worker cannot run.
 * Probabilistic, not a guarantee. Labels are the censor's own; which ones block is the game's setting.
 */

export { IMAGECENSOR_LABELS };
const DEFAULT_BLOCK = ["BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED", "FEMALE_GENITALIA_EXPOSED", "ANUS_EXPOSED", "MALE_GENITALIA_EXPOSED"];

const cfg = IMAGES?.safety;
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1 ? v : d);
export const SAFETY = cfg ? {
  threshold: num(cfg.threshold, 0.5),
  labels: (Array.isArray(cfg.labels) ? cfg.labels : DEFAULT_BLOCK).filter((l): l is string => IMAGECENSOR_LABELS.includes(l as string)),
  uploads: cfg.uploads !== false,
  renders: cfg.renders !== false,
} : null;

export type { Hit };
export type Classifier = (bytes: Buffer) => Promise<Hit[]>;
export class UnsafeImage extends Error { constructor(readonly hits: Hit[]) { super(`picture refused: ${hits.map((h) => `${h.label} ${h.score.toFixed(2)}`).join(", ")}`); } }
export class SafetyUnavailable extends Error { constructor(why: string) { super(`picture check unavailable: ${why}`); } }

/** The labels the censor found that this game blocks at its threshold (the worker reports everything it saw; the decision is here). */
const detect: Classifier = async (bytes) => (await visionCensor(bytes)).filter((h) => SAFETY!.labels.includes(h.label) && h.score >= SAFETY!.threshold);

let classifier: Classifier = detect;
/** Tests inject a fake; null restores the real one. */
export const setClassifier = (c: Classifier | null): void => { classifier = c ?? detect; };

/** Throws UnsafeImage when the picture is flagged, SafetyUnavailable when it cannot be checked. No-op when `safety` is off for this kind. */
export async function screen(bytes: Buffer, where: "upload" | "render"): Promise<void> {
  if (!SAFETY || !(where === "upload" ? SAFETY.uploads : SAFETY.renders)) return;
  let hits: Hit[];
  try { hits = await classifier(bytes); } catch (e) { throw new SafetyUnavailable((e as Error).message); }
  if (hits.length) throw new UnsafeImage(hits);
}
