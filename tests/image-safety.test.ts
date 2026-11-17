import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { makeRenderer, PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images-safety");
process.env.PUBLIC_URL = "https://game.example";
process.env.IMAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "img-safety-"));
const ollama = makeOllama();
let renderer: ReturnType<typeof makeRenderer>;
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
let safety: typeof import("../src/utils/image-safety.js");
let ref: typeof import("../src/utils/image-ref.js");

beforeAll(async () => {
  renderer = makeRenderer();
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
  safety = await import("../src/utils/image-safety.js");
  ref = await import("../src/utils/image-ref.js");
});
beforeEach(() => {
  ollama.reset();
  renderer.s.calls.length = 0; renderer.s.output = PNG;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => safety.setClassifier(null));

type M = { role: string; content: unknown };
const u = (content: unknown): M => ({ role: "user", content });
async function say(id: string, messages: M[]): Promise<string> {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)?.tail;
  return r.body.choices[0].message.content;
}
const dataUri = "data:image/png;base64," + PNG.toString("base64");
const flagged = async () => [{ label: "FEMALE_BREAST_EXPOSED", score: 0.9 }];

describe("image safety: config and reading the detector", () => {
  it("is on with the game's threshold and a default list of exposed labels", () => {
    expect(safety.SAFETY!.threshold).toBe(0.4);
    expect(safety.SAFETY!.labels).toContain("FEMALE_GENITALIA_EXPOSED");
    expect(safety.SAFETY!.labels).not.toContain("FACE_FEMALE");
  });
  it("fails closed when the model file is missing (real detector)", async () => {
    await expect(safety.screen(PNG, "upload")).rejects.toBeInstanceOf(safety.SafetyUnavailable);
  });
});

describe("image safety: uploads", () => {
  it("lets a clean attached picture through and refuses a flagged one", async () => {
    safety.setClassifier(async () => []);
    expect((await ref.loadReference(dataUri)).kind).toBe("png");
    safety.setClassifier(flagged);
    await expect(ref.loadReference(dataUri)).rejects.toBeInstanceOf(safety.UnsafeImage);
  });
  it("does not check pictures from the game folder", async () => {
    safety.setClassifier(flagged);
    expect((await ref.loadReference("ref.png")).kind).toBe("png");
  });
  it("refuses a flagged fetched picture", async () => {
    safety.setClassifier(flagged);
    const fetchOk = (async () => new Response(new Uint8Array(PNG), { status: 200 })) as unknown as typeof fetch;
    await expect(ref.loadReference("https://x.example/a.png", { fetch: fetchOk, allowUrls: true, lookup: async () => ["93.184.216.34"] })).rejects.toBeInstanceOf(safety.UnsafeImage);
  });
  it("/portrait with a flagged attachment says so and stores nothing", async () => {
    const t = await say("s1", [u("let us begin")]);
    safety.setClassifier(flagged);
    const reply = await say("s1", [u("let us begin"), { role: "assistant", content: t }, u([{ type: "text", text: "/portrait Bo" }, { type: "image_url", image_url: { url: dataUri } }])]);
    expect(reply).toBe("That picture is not allowed here.");
    expect(sessions.get("chat:s1")!.visuals?.refs.npc_bo).toBeUndefined();
    expect(renderer.s.calls).toHaveLength(0);
  });
});

describe("image safety: renders", () => {
  it("refuses a flagged render and never stores or links it", async () => {
    const t = await say("s2", [u("let us begin")]);
    const dir = process.env.IMAGE_DIR!;
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    safety.setClassifier(flagged);
    const reply = await say("s2", [u("let us begin"), { role: "assistant", content: t }, u("/draw the door")]);
    expect(reply).toBe("That picture is not allowed here.");
    expect(reply).not.toContain("![");
    expect(fs.readdirSync(dir).length).toBe(before);
  });
  it("answers that pictures cannot be checked when the detector fails, and uses none", async () => {
    const t = await say("s3", [u("let us begin")]);
    safety.setClassifier(async () => { throw new Error("boom"); });
    const reply = await say("s3", [u("let us begin"), { role: "assistant", content: t }, u("/draw the door")]);
    expect(reply).toBe("Pictures cannot be checked right now, so none is used.");
  });
  it("serves a clean render", async () => {
    const t = await say("s4", [u("let us begin")]);
    safety.setClassifier(async () => []);
    expect(await say("s4", [u("let us begin"), { role: "assistant", content: t }, u("/draw the door")])).toContain("![");
  });
});
