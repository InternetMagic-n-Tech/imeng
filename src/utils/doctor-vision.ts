import type { Finding, Sys, Settings } from "./doctor.js";
import { expand } from "./image-plan.js";

/** Doctor checks for the `vision` block (the host-only Python worker for seat pictures and the image censor). Nothing is reported without it. */
const f = (level: Finding["level"], id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level, title, detail, fix });

export async function checkVision({ sys, s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  const v = (s.game as { vision?: { venv?: string; pose_weights?: string; url?: string; script?: string; device?: string } }).vision;
  if (!v) return [];
  if (v.url) return [f("info", "vision", `Pictures are checked by the vision service at ${v.url}`, "It must answer the worker's JSON (see src/tools/vision/README.md).")];
  const out: Finding[] = [], missing: string[] = [];
  const fill = (x: string): string => { const r = expand(x, sys.env); missing.push(...r.missing); return r.text; };
  const venv = v.venv ? fill(v.venv) : "", weights = v.pose_weights ? fill(v.pose_weights) : "";
  if (missing.length) return [f("fail", "vision", `vision needs the environment variable(s): ${[...new Set(missing)].join(", ")}`, "No picture can be checked until they are set (the checks fail closed).", "Set them on the host (see env-example and src/tools/vision/README.md).")];
  if (venv && !sys.exists(venv)) out.push(f("fail", "vision", `The vision venv ${venv} does not exist`, "The worker cannot start.", `python3 -m venv ${venv} && ${venv}/bin/pip install -r src/tools/vision/requirements.txt`));
  else out.push(f("ok", "vision", venv ? `Vision worker venv ${venv}` : "Vision worker uses the system python"));
  if (weights && !sys.exists(weights)) out.push(f("fail", "vision-weights", `The pose weights ${weights} were not found`, "Seat pictures cannot be checked (the weights are never downloaded).", "Download a YOLO-pose weights file once and point vision.pose_weights at it."));
  if (v.device === "cuda") out.push(f("info", "vision-gpu", "The vision worker uses the GPU", "Each check runs inside the picture GPU lease and the worker stops when idle outside production."));
  return out;
}
