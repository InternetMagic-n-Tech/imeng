import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";
import { PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
const { render, freeRenderer, fillWorkflow } = await import("../src/utils/image-adapters.js");
const { IMAGES } = await import("../src/utils/image-config.js");
const cfg = IMAGES!;
const job = { positive: "p", negative: "n", seed: 7, width: 512, height: 640 };
const sleep = async () => {};
type Call = { url: string; init?: RequestInit };
function io(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = jest.fn(async (u: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(u), init }); return handler(String(u), init); }) as unknown as typeof fetch;
  return { io: { fetch: f, sleep }, calls };
}
const j = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });

describe("workflow placeholders", () => {
  it("keeps numbers as numbers when the whole string is one placeholder", () => {
    expect(fillWorkflow({ a: "${seed}", b: ["x ${positive} y", { c: "${nope}" }] }, { seed: 5, positive: "cat" })).toEqual({ a: 5, b: ["x cat y", { c: "${nope}" }] });
  });
});

describe("ComfyUI", () => {
  const comfy = (history: () => unknown, extra: (u: string) => Response | null = () => null) => io((u) => {
    const e = extra(u); if (e) return e;
    if (u.endsWith("/prompt")) return j({ prompt_id: "p1", node_errors: {} });
    if (u.includes("/history/")) return j(history());
    if (u.includes("/view?")) return new Response(new Uint8Array(PNG));
    if (u.endsWith("/upload/image")) return j({ name: "up.png" });
    return new Response("?", { status: 404 });
  });
  const done = { p1: { outputs: { 9: { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } };

  it("queues the filled workflow, waits for the history and downloads the picture", async () => {
    let polls = 0;
    const c = comfy(() => (polls++ < 2 ? {} : done));
    const r = await render(job, cfg, c.io);
    expect(r.kind).toBe("png");
    const sent = JSON.parse(String(c.calls.find((x) => x.url.endsWith("/prompt"))!.init!.body)).prompt;
    expect(sent["3"].inputs).toEqual({ seed: 7, steps: 12, cfg: 7 });
    expect(sent["6"].inputs.text).toBe("p");
    expect(sent["5"].inputs).toEqual({ width: 512, height: 640 });
    expect(polls).toBe(3);
  });
  it("uploads a reference and uses the reference workflow", async () => {
    const c = comfy(() => done);
    await render({ ...job, reference: { bytes: PNG, kind: "png" } }, cfg, c.io);
    expect(c.calls.some((x) => x.url.endsWith("/upload/image"))).toBe(true);
    const sent = JSON.parse(String(c.calls.find((x) => x.url.endsWith("/prompt"))!.init!.body)).prompt;
    expect(sent["10"].inputs.image).toBe("up.png");
  });
  it("reports a rejected workflow, a missing Save node, a bad status and a timeout", async () => {
    const bad = io((u) => (u.endsWith("/prompt") ? j({ prompt_id: "p1", node_errors: { 3: "x" } }) : new Response("?", { status: 404 })));
    await expect(render(job, cfg, bad.io)).rejects.toThrow("rejected the workflow");
    await expect(render(job, cfg, comfy(() => ({ p1: { outputs: { 1: {} } } })).io)).rejects.toThrow("Save Image");
    await expect(render(job, cfg, io(() => new Response("no", { status: 500 })).io)).rejects.toThrow("500");
    await expect(render(job, cfg, comfy(() => done, (u) => (u.includes("/view?") ? new Response("", { status: 500 }) : null)).io)).rejects.toThrow("/view answered 500");
    const slow = comfy(() => ({}));
    const real = Date.now; let t = 0; Date.now = () => (t += 400000);
    try { await expect(render(job, cfg, slow.io)).rejects.toThrow("too long"); } finally { Date.now = real; }
  });
  it("needs the workflow file named in config.json", async () => {
    await expect(render(job, { ...cfg, workflow: undefined }, io(() => j({})).io)).rejects.toThrow("needs");
    await expect(render(job, { ...cfg, workflow: "../../package.json" }, io(() => j({})).io)).rejects.toThrow("needs");
  });
  it("asks ComfyUI to free its memory, and survives when it cannot", async () => {
    const c = io(() => j({}));
    await freeRenderer(cfg, c.io);
    expect(c.calls[0].url).toMatch(/\/free$/);
    await freeRenderer(cfg, { fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch, sleep });
  });
});

describe("AUTOMATIC1111", () => {
  const a = { ...cfg, renderer: "a1111" as const, model: "m.safetensors", strength: 0.5 };
  it("txt2img with the seed and negative prompt, img2img with a reference", async () => {
    const c = io(() => j({ images: [PNG.toString("base64")] }));
    expect((await render(job, a, c.io)).kind).toBe("png");
    const body = JSON.parse(String(c.calls[0].init!.body));
    expect(c.calls[0].url).toMatch(/txt2img$/);
    expect(body).toMatchObject({ seed: 7, negative_prompt: "n", width: 512, override_settings: { sd_model_checkpoint: "m.safetensors" } });
    const d = io(() => j({ images: ["data:image/png;base64," + PNG.toString("base64")] }));
    await render({ ...job, reference: { bytes: PNG, kind: "png" } }, a, d.io);
    expect(d.calls[0].url).toMatch(/img2img$/);
    expect(JSON.parse(String(d.calls[0].init!.body))).toMatchObject({ denoising_strength: 0.5, init_images: [PNG.toString("base64")] });
    await expect(render(job, a, io(() => j({})).io)).rejects.toThrow("no picture");
    await freeRenderer(a, c.io);
    expect(c.calls.at(-1)!.url).toMatch(/unload-checkpoint$/);
  });
});

describe("which checkpoint", () => {
  it("IMAGE_MODEL wins over config.json for A1111, and ComfyUI workflows may use ${model}", async () => {
    process.env.IMAGE_MODEL = "env.safetensors";
    try {
      const c = io(() => j({ images: [PNG.toString("base64")] }));
      await render(job, { ...cfg, renderer: "a1111" as const, model: "m.safetensors" }, c.io);
      expect(JSON.parse(String(c.calls[0].init!.body)).override_settings.sd_model_checkpoint).toBe("env.safetensors");
      expect(fillWorkflow({ ckpt_name: "${model}" }, { model: "env.safetensors" })).toEqual({ ckpt_name: "env.safetensors" });
    } finally { delete process.env.IMAGE_MODEL; }
    const none = io(() => j({ images: [PNG.toString("base64")] }));
    await render(job, { ...cfg, renderer: "a1111" as const, model: undefined }, none.io);
    expect(JSON.parse(String(none.calls[0].init!.body)).override_settings).toBeUndefined();
  });
});

describe("OpenAI-style and Ollama", () => {
  it("reads b64_json or a url, and says when there is neither", async () => {
    const o = { ...cfg, renderer: "openai" as const };
    const b = io(() => j({ data: [{ b64_json: PNG.toString("base64") }] }));
    expect((await render(job, o, b.io)).kind).toBe("png");
    expect(JSON.parse(String(b.calls[0].init!.body))).toMatchObject({ size: "512x640", negative_prompt: "n" });
    const u = io((url) => (url.endsWith("/v1/images/generations") ? j({ data: [{ url: "http://x/y.png" }] }) : new Response(new Uint8Array(PNG))));
    expect((await render(job, { ...o, renderer: "ollama" }, u.io)).kind).toBe("png");
    await expect(render(job, o, io(() => j({ data: [] })).io)).rejects.toThrow("no picture");
    await expect(render(job, o, io((url) => (url.endsWith("/v1/images/generations") ? j({ data: [{ url: "http://x/y.png" }] }) : new Response("", { status: 500 }))).io)).rejects.toThrow("500");
    await freeRenderer(o, b.io); // nothing to free: no call
    expect(b.calls).toHaveLength(1);
  });
});
