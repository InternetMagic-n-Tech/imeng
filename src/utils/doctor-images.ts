import path from "node:path";
import { IMAGECENSOR_LABELS } from "./image-labels.js";
import { plan, expand } from "./image-plan.js";
import type { Finding } from "./doctor.js";
import type { Sys, Settings } from "./doctor.js";

/** Doctor checks for the config.json `images` block. Nothing is reported when the block is absent. */

const f = (level: Finding["level"], id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level, title, detail, fix });
const DEFAULT_URLS: Record<string, string> = { comfyui: "http://127.0.0.1:8188", a1111: "http://127.0.0.1:7860", openai: "http://127.0.0.1:8080", ollama: "http://127.0.0.1:11434" };

export async function checkImages({ sys, s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  const im = s.game.images;
  if (!im) return [];
  const out: Finding[] = [];
  const problems: string[] = [];
  const readFlow = (rel: string, needs: string[]): void => {
    const file = path.resolve(s.gameDir, rel);
    if (!file.startsWith(path.resolve(s.gameDir) + path.sep)) { problems.push(`${rel} is outside the game folder`); return; }
    const text = sys.readFile(file);
    if (text === null) { problems.push(`${rel} was not found`); return; }
    try { JSON.parse(text); } catch { problems.push(`${rel} is not valid JSON (export it with Save (API Format))`); return; }
    for (const n of needs) if (!text.includes("${" + n + "}")) problems.push(`${rel} has no \${${n}} placeholder`);
  };
  if (im.renderer === "comfyui") {
    if (!im.workflow) problems.push('renderer "comfyui" needs "workflow"');
    else readFlow(im.workflow, ["positive", "seed"]);
    if (im.workflow_reference) readFlow(im.workflow_reference, ["positive", "seed", "reference"]);
  }
  const ref = im.reference?.default;
  if (ref && !/^https?:\/\//i.test(ref) && !sys.exists(path.resolve(s.gameDir, ref))) problems.push(`reference.default ${ref} was not found`);
  if (ref && /^https?:\/\//i.test(ref) && !im.reference?.urls) problems.push("reference.default is a URL but reference.urls is not true");
  let venv: string | undefined;
  if (im.process) { try { venv = plan(im.process, sys.env).venv; } catch (e) { problems.push((e as Error).message); } }
  out.push(problems.length ? f("fail", "images-config", "config.json images has problems", problems.join("; "), "Fix the images block.") : f("ok", "images-config", `Images: renderer ${im.renderer}`));

  if (venv && !sys.exists(venv)) out.push(f("warn", "images-venv", `The renderer's venv ${venv} does not exist`, "The first picture will fail until it does.", `Create it (python3 -m venv ${venv}) and install the renderer's requirements in it, or run the renderer's own installer once.`));
  if (!sys.env.PUBLIC_URL) out.push(f("info", "images-public-url", `Picture links use http://localhost:${s.port}`, "Anyone not on this machine cannot open them.", "Set PUBLIC_URL to the address people reach this proxy at."));
  const url = (sys.env.IMAGE_URL || im.url || DEFAULT_URLS[im.renderer]).replace(/\/+$/, "");
  const up = await sys.http(url, undefined, 4000);
  if (up) out.push(f("ok", "images-renderer", `The renderer answers at ${url}`));
  const model = sys.env.IMAGE_MODEL || im.model;
  if (up && model && im.renderer === "a1111") {
    const list = await sys.http(`${url}/sdapi/v1/sd-models`, undefined, 6000);
    const names: string[] = Array.isArray(list?.json) ? (list!.json as { title?: string; model_name?: string; filename?: string }[]).flatMap((m) => [m.title, m.model_name, m.filename].filter((x): x is string => typeof x === "string")) : [];
    if (list?.ok && Array.isArray(list.json)) out.push(names.some((n) => n === model || n.startsWith(model + " [") || n.endsWith("/" + model)) ? f("ok", "images-model", `Checkpoint ${model} is installed`) : f("fail", "images-model", `Checkpoint ${model} is not in the renderer's list`, `It has: ${[...new Set(names)].slice(0, 6).join(", ") || "nothing"}`, "Use a name from /sdapi/v1/sd-models (title or model_name), or put the file in models/Stable-diffusion."));
  }
  else if (im.process) out.push(f("info", "images-renderer", `Nothing answers at ${url} yet`, "The engine will start images.process on the first picture."));
  else out.push(f("warn", "images-renderer", `Nothing answers at ${url}`, "/draw will fail until the renderer is running.", "Start it, or describe how to start it in images.process."));
  if (im.safety) {
    const sf = im.safety, bad: string[] = [];
    if (sf.threshold !== undefined && !(typeof sf.threshold === "number" && sf.threshold > 0 && sf.threshold <= 1)) bad.push("safety.threshold must be above 0 and at most 1");
    if (sf.labels !== undefined && !(Array.isArray(sf.labels) && sf.labels.length && sf.labels.every((l) => IMAGECENSOR_LABELS.includes(l)))) bad.push("safety.labels must be a non-empty list of image censor labels");
    if (bad.length) out.push(f("fail", "images-safety", "config.json images.safety has problems", bad.join("; "), "Fix the safety block."));
    else if (!s.game.vision) out.push(f("fail", "images-safety", "images.safety needs the vision module", "Every picture is refused until the vision block exists (the check fails closed).", "Add a vision block (see src/tools/vision/README.md)."));
    else out.push(f("ok", "images-safety", "Picture safety check on (the vision module's image censor)"));
  }
  if (!(im.lease?.unload_narrator ?? true)) out.push(f("info", "images-lease", "The narrator is not unloaded around a picture", "A big narrator and the renderer may not fit in VRAM together.", "Leave lease.unload_narrator on unless there is room for both."));
  return out;
}
