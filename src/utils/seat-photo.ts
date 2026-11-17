import path from "node:path";
import { SEATING } from "./config.js";
import { readGameMd } from "./game-md.js";
import { sniff, usable } from "./image-format.js";
import { screen, UnsafeImage, SafetyUnavailable } from "./image-safety.js";
import { VISION } from "./config.js";
import { visionPose, visionCensor } from "./vision.js";

/**
 * The seat photo (config.json `seating.photo`): to take a seat a person sends one picture of themselves. Code checks it, a model only reads it:
 *  - safe for work (the same image censor as `images.safety`, when that is on),
 *  - exactly one person (a pose model counts them),
 *  - a face reference (the nose shows; with `check.eyes` set, both eyes must show too; a covered mouth is fine) or a body reference (both shoulders and both hips show, "thighs to chin").
 * The people come from the vision module (the host-only Python worker, config.json `vision`) or from `check.url` (a local HTTP service). Both give the same thing: people with 17 COCO
 * keypoints (x, y, confidence); all the rules above are here, in Node. Fails closed when it cannot run. Probabilistic, not a guarantee.
 */
export interface KeyPoint { x: number; y: number; c: number }
export interface Person { score: number; keypoints: KeyPoint[] }
export type PoseRunner = (bytes: Buffer) => Promise<Person[]>;
export type Verdict = { ok: true; kind: "face" | "body" } | { ok: false; reason: "format" | "unsafe" | "down" | "none" | "many" | "unclear" };

const NOSE = 0, L_EYE = 1, R_EYE = 2, L_SHOULDER = 5, R_SHOULDER = 6, L_HIP = 11, R_HIP = 12;

/** Pure: judge the people a model found. `people` is how many are allowed (1), `keypoint` the confidence a keypoint needs to count as visible, `eyes` (0 = off) the confidence both eyes need for a face to count, `faceMin` (0 = off) the censor's best face box score a face needs (`faceScore`); a face that fails any of these falls to the body test. */
export function judgePose(found: Person[], o: { threshold: number; keypoint: number; people: number; eyes?: number; faceMin?: number; faceScore?: number }): Verdict {
  const real = found.filter((p) => p.score >= o.threshold);
  if (!real.length) return { ok: false, reason: "none" };
  if (real.length > o.people) return { ok: false, reason: "many" };
  const k = real[0].keypoints, seen = (i: number): boolean => (k[i]?.c ?? 0) >= o.keypoint;
  const eyesOk = !o.eyes || ((k[L_EYE]?.c ?? 0) >= o.eyes && (k[R_EYE]?.c ?? 0) >= o.eyes);
  const faceOk = !o.faceMin || (o.faceScore ?? 0) >= o.faceMin;
  if (seen(NOSE) && eyesOk && faceOk) return { ok: true, kind: "face" };
  if (seen(L_SHOULDER) && seen(R_SHOULDER) && seen(L_HIP) && seen(R_HIP)) return { ok: true, kind: "body" };
  return { ok: false, reason: "unclear" };
}

const check = () => SEATING?.photo?.check;

/** A local HTTP checker: POST the picture, answer `{"people":[{"score":0.9,"keypoints":[[x,y,confidence] x 17]}]}`. */
const runHttp: PoseRunner = async (bytes) => {
  const r = await fetch(check()!.url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`the checker answered ${r.status}`);
  const j: any = await r.json();
  return (Array.isArray(j?.people) ? j.people : []).map((p: any) => ({ score: Number(p?.score) || 0, keypoints: (Array.isArray(p?.keypoints) ? p.keypoints : []).slice(0, 17).map((k: any) => ({ x: Number(k?.[0]) || 0, y: Number(k?.[1]) || 0, c: Number(k?.[2]) || 0 })) }));
};

let runner: PoseRunner | null = null;
/** Tests inject a fake; null restores the configured one. */
export const setPoseRunner = (r: PoseRunner | null): void => { runner = r; };

/** The whole check for one picture. Never throws. */
export async function checkSeatPhoto(bytes: Buffer): Promise<Verdict> {
  const P = SEATING?.photo;
  if (!P) return { ok: false, reason: "down" };
  if (!usable(sniff(bytes))) return { ok: false, reason: "format" };
  try { await screen(bytes, "upload"); } catch (e) { return { ok: false, reason: e instanceof UnsafeImage ? "unsafe" : e instanceof SafetyUnavailable ? "down" : "down" }; }
  try {
    const run = runner ?? (P.check.url ? runHttp : VISION ? visionPose : null);
    if (!run) return { ok: false, reason: "down" };
    let faceScore: number | undefined;
    if (P.check.faceMin) {
      if (!VISION) return { ok: false, reason: "down" };
      faceScore = Math.max(0, ...(await visionCensor(bytes)).filter((h) => h.label.startsWith("FACE_")).map((h) => h.score));
    }
    return judgePose(await run(bytes), { threshold: P.check.threshold, keypoint: P.check.keypoint, people: P.check.people, eyes: P.check.eyes, faceMin: P.check.faceMin, faceScore });
  } catch (e) { console.warn(`seat photo check unavailable: ${(e as Error).message}`); return { ok: false, reason: "down" }; }
}

/** The message sent when a person confirms a seat: the game's own `text_file` (a markdown file in the imeng folder), else the default. {hours} is how long photos are kept. */
export function photoRules(): string {
  const P = SEATING!.photo!;
  const text = readGameMd(P.textFile);
  return (text || P.texts.rules).replace(/\{hours\}/g, String(P.keepHours));
}

/** Pictures attached to the latest user message (data: URIs), before any capture swaps them for placeholders. */
export function imagesOf(content: unknown, parse: (uri: string) => { mime: string; bytes: Buffer } | null): { mime: string; bytes: Buffer }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((p: any) => { if (p?.type !== "image_url") return []; const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url; const x = typeof u === "string" ? parse(u) : null; return x ? [x] : []; });
}
