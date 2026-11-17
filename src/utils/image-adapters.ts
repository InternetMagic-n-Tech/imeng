import fs from "node:fs";
import { IMAGES, IMAGE_URL, IMAGE_TIMEOUT_MS, gameFile } from "./image-config.js";
import { sniff, mimeOf } from "./image-format.js";
import type { ImageKind } from "./image-format.js";
import type { ImagesConfig } from "./types.js";

/** One picture from a renderer. Every call goes through `io.fetch`, so tests never need a real renderer. */

export interface Job { positive: string; negative: string; seed: number; width: number; height: number; reference?: { bytes: Buffer; kind: ImageKind } }
export interface RenderIO { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }
/** The checkpoint: env IMAGE_MODEL (machine-specific) over config.json images.model. */
export const modelOf = (cfg: ImagesConfig): string | undefined => process.env.IMAGE_MODEL || cfg.model || undefined;
export const realIO: RenderIO = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const sig = (): AbortSignal => AbortSignal.timeout(IMAGE_TIMEOUT_MS);
const post = (io: RenderIO, url: string, body: unknown): Promise<Response> => io.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: sig() });
async function json(r: Response, what: string): Promise<any> {
  if (!r.ok) throw new Error(`${what} answered ${r.status}`);
  return r.json();
}

/** Fill ${placeholders} through a parsed workflow. A string that is exactly one placeholder becomes the value itself (a number stays a number). */
export function fillWorkflow(node: unknown, vars: Record<string, string | number>): unknown {
  if (typeof node === "string") {
    const whole = /^\$\{(\w+)\}$/.exec(node);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return node.replace(/\$\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map((n) => fillWorkflow(n, vars));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillWorkflow(v, vars)]));
  return node;
}

async function comfy(cfg: ImagesConfig, job: Job, io: RenderIO): Promise<Buffer> {
  const rel = job.reference ? cfg.workflow_reference : cfg.workflow;
  const file = rel ? gameFile(rel) : null;
  if (!file) throw new Error(`comfyui needs "${job.reference ? "workflow_reference" : "workflow"}" (a file in the game folder)`);
  const vars: Record<string, string | number> = { positive: job.positive, negative: job.negative, seed: job.seed, width: job.width, height: job.height, steps: cfg.steps ?? 20, cfg: cfg.cfg ?? 7, ...(modelOf(cfg) ? { model: modelOf(cfg)! } : {}) };
  if (job.reference) {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(job.reference.bytes)], { type: mimeOf(job.reference.kind) }), `ref.${job.reference.kind === "jpeg" ? "jpg" : job.reference.kind}`);
    form.append("overwrite", "true");
    const up = await json(await io.fetch(`${IMAGE_URL}/upload/image`, { method: "POST", body: form, signal: sig() }), "ComfyUI upload");
    vars.reference = up.name;
  }
  const workflow = fillWorkflow(JSON.parse(fs.readFileSync(file, "utf8")), vars);
  const queued = await json(await post(io, `${IMAGE_URL}/prompt`, { prompt: workflow, client_id: "imeng" }), "ComfyUI /prompt");
  if (queued.node_errors && Object.keys(queued.node_errors).length) throw new Error("ComfyUI rejected the workflow: " + JSON.stringify(queued.node_errors).slice(0, 300));
  const id: string = queued.prompt_id;
  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  for (;;) {
    const h = await json(await io.fetch(`${IMAGE_URL}/history/${encodeURIComponent(id)}`, { signal: sig() }), "ComfyUI history");
    const out = h[id]?.outputs;
    if (out) {
      for (const node of Object.values<any>(out)) {
        const img = node?.images?.[0];
        if (img) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
          const r = await io.fetch(`${IMAGE_URL}/view?${q}`, { signal: sig() });
          if (!r.ok) throw new Error(`ComfyUI /view answered ${r.status}`);
          return Buffer.from(await r.arrayBuffer());
        }
      }
      throw new Error("ComfyUI finished without a picture (does the workflow have a Save Image node?)");
    }
    if (Date.now() > deadline) throw new Error("ComfyUI took too long");
    await io.sleep(1000);
  }
}

async function a1111(cfg: ImagesConfig, job: Job, io: RenderIO): Promise<Buffer> {
  const body: Record<string, unknown> = {
    prompt: job.positive, negative_prompt: job.negative, seed: job.seed, width: job.width, height: job.height,
    steps: cfg.steps ?? 20, cfg_scale: cfg.cfg ?? 7, sampler_name: cfg.sampler, ...(modelOf(cfg) ? { override_settings: { sd_model_checkpoint: modelOf(cfg) } } : {}),
  };
  if (job.reference) { body.init_images = [job.reference.bytes.toString("base64")]; body.denoising_strength = cfg.strength ?? 0.6; }
  const j = await json(await post(io, `${IMAGE_URL}/sdapi/v1/${job.reference ? "img2img" : "txt2img"}`, body), "AUTOMATIC1111");
  if (!j.images?.[0]) throw new Error("AUTOMATIC1111 returned no picture");
  return Buffer.from(String(j.images[0]).replace(/^data:[^,]*,/, ""), "base64");
}

/** openai and ollama: POST /v1/images/generations. No seed and (usually) no negative prompt reach the model; they are sent for servers that accept them (Open WebUI does). */
async function openai(cfg: ImagesConfig, job: Job, io: RenderIO): Promise<Buffer> {
  const j = await json(await post(io, `${IMAGE_URL}/v1/images/generations`, {
    model: modelOf(cfg), prompt: job.positive, negative_prompt: job.negative, n: 1, size: `${job.width}x${job.height}`, steps: cfg.steps, response_format: "b64_json",
  }), "the image server");
  const d = j.data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, "base64");
  if (d?.url) {
    const r = await io.fetch(d.url, { signal: sig() });
    if (!r.ok) throw new Error(`image URL answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error("the image server returned no picture");
}

export async function render(job: Job, cfg: ImagesConfig = IMAGES!, io: RenderIO = realIO): Promise<{ bytes: Buffer; kind: ImageKind }> {
  const run = cfg.renderer === "comfyui" ? comfy : cfg.renderer === "a1111" ? a1111 : openai;
  const bytes = await run(cfg, job, io);
  return { bytes, kind: sniff(bytes) };
}

/** Ask the renderer to give its VRAM back (best effort: a renderer without the call is left alone). */
export async function freeRenderer(cfg: ImagesConfig = IMAGES!, io: RenderIO = realIO): Promise<void> {
  try {
    if (cfg.renderer === "comfyui") await post(io, `${IMAGE_URL}/free`, { unload_models: true, free_memory: true });
    else if (cfg.renderer === "a1111") await post(io, `${IMAGE_URL}/sdapi/v1/unload-checkpoint`, {});
  } catch (e) { console.warn("could not free the renderer:", (e as Error).message); }
}
