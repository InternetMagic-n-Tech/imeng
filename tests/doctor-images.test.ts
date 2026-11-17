import { describe, it, expect } from "@jest/globals";
import { runDoctor } from "../src/utils/doctor.js";
import type { Finding } from "../src/utils/doctor.js";
import { makeSettings, makeSys } from "./fake-sys.js";

const flow = JSON.stringify({ a: { text: "${positive}", seed: "${seed}" } });
const refFlow = JSON.stringify({ a: { text: "${positive}", seed: "${seed}", image: "${reference}" } });
const run = async (images: unknown, sys: Parameters<typeof makeSys>[0] = {}, env: Record<string, string> = {}): Promise<Finding[]> => {
  const s = makeSys({ ...sys, files: { "/game/w.json": flow, "/game/wr.json": refFlow, "/game/ref.png": "x", ...(sys.files || {}) } });
  s.env = env;
  return (await runDoctor(s, makeSettings({ game: { images } as never }))).findings.filter((f) => f.id.startsWith("images-"));
};
const level = (fs: Finding[], id: string) => fs.find((f) => f.id === id)?.level;
const up = { routes: { "GET http://127.0.0.1:8188": { ok: true, status: 200 } } };

describe("doctor: images", () => {
  it("says nothing when the game has no images block", async () => {
    expect(await run(undefined)).toEqual([]);
  });
  it("is happy with a good ComfyUI setup", async () => {
    const f = await run({ renderer: "comfyui", workflow: "w.json", workflow_reference: "wr.json", reference: { default: "ref.png" } }, up, { PUBLIC_URL: "https://g" });
    expect(level(f, "images-config")).toBe("ok");
    expect(level(f, "images-renderer")).toBe("ok");
    expect(f.find((x) => x.id === "images-public-url")).toBeUndefined();
  });
  it("finds a missing, broken or placeholder-less workflow and a bad reference", async () => {
    const bad = await run({ renderer: "comfyui", workflow: "nope.json", workflow_reference: "w.json", reference: { default: "gone.png" } }, up);
    const detail = bad.find((x) => x.id === "images-config")!.detail!;
    expect(detail).toContain("nope.json was not found");
    expect(detail).toContain("w.json has no ${reference} placeholder");
    expect(detail).toContain("reference.default gone.png was not found");
    expect((await run({ renderer: "comfyui" }, up)).find((x) => x.id === "images-config")!.detail).toContain('needs "workflow"');
    expect((await run({ renderer: "comfyui", workflow: "../x.json" }, up)).find((x) => x.id === "images-config")!.detail).toContain("outside the game folder");
    expect((await run({ renderer: "comfyui", workflow: "w.json" }, { ...up, files: { "/game/w.json": "{ nope" } })).find((x) => x.id === "images-config")!.detail).toContain("not valid JSON");
    expect((await run({ renderer: "comfyui", workflow: "w.json", reference: { default: "https://x/y.png" } }, up)).find((x) => x.id === "images-config")!.detail).toContain("reference.urls");
  });
  it("checks the process placeholders against the environment", async () => {
    const im = { renderer: "a1111", process: { command: "${PY}", args: ["--port", "${PORT}"] } };
    expect((await run(im, {})).find((x) => x.id === "images-config")!.detail).toContain("PY, PORT");
    expect(level(await run(im, {}, { PY: "python3", PORT: "7860" }), "images-config")).toBe("ok");
  });
  it("tells a renderer that is down from one the engine will start", async () => {
    expect(level(await run({ renderer: "a1111" }), "images-renderer")).toBe("warn");
    expect(level(await run({ renderer: "a1111", process: { command: "x" } }), "images-renderer")).toBe("info");
    expect(level(await run({ renderer: "openai", url: "http://127.0.0.1:9/", lease: { unload_narrator: false } }), "images-lease")).toBe("info");
    expect(level(await run({ renderer: "ollama" }), "images-public-url")).toBe("info");
  });
  it("warns when the renderer's venv folder is missing", async () => {
    const f = await run({ renderer: "a1111", process: { command: "python", venv: "/sd/venv" } });
    expect(f.find((x) => x.id === "images-venv")?.level).toBe("warn");
    const ok = await run({ renderer: "a1111", process: { command: "python", venv: "/sd/venv" } }, { files: { "/sd/venv": "" } });
    expect(ok.find((x) => x.id === "images-venv")).toBeUndefined();
  });
  it("checks the checkpoint name against the renderer's own list", async () => {
    const a1111 = { "GET http://127.0.0.1:7860": { ok: true, status: 200 } };
    const list = (m: unknown[]) => ({ ...a1111, "GET http://127.0.0.1:7860/sdapi/v1/sd-models": { ok: true, status: 200, json: m } });
    const have = [{ title: "dream.safetensors [abc123]", model_name: "dream", filename: "/sd/models/Stable-diffusion/dream.safetensors" }];
    expect(level(await run({ renderer: "a1111", model: "dream" }, { routes: list(have) as never }), "images-model")).toBe("ok");
    expect(level(await run({ renderer: "a1111", model: "dream.safetensors" }, { routes: list(have) as never }), "images-model")).toBe("ok");
    expect(level(await run({ renderer: "a1111", model: "nope" }, { routes: list(have) as never }), "images-model")).toBe("fail");
    expect(level(await run({ renderer: "a1111", model: "x" }, { routes: list(have) as never }, { IMAGE_MODEL: "dream" }), "images-model")).toBe("ok");
  });
  it("images.safety needs the vision module, and its threshold and labels are checked", async () => {
    expect(level(await run({ renderer: "a1111", safety: {} }, {}), "images-safety")).toBe("fail"); // no vision block: nothing can be checked
    expect((await run({ renderer: "a1111", safety: { threshold: 2, labels: ["NOPE"] } }, {})).find((x) => x.id === "images-safety")!.detail).toContain("threshold");
  });
});
