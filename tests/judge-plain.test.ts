import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

// plain fixture: no condition in the prompt, judge instance on the GPU with default settings
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/plain");
process.env.OLLAMA_MODELS = "/data/models";

const silentSpawn = jest.fn((..._a: unknown[]) => ({ child: { kill: jest.fn() }, promise: new Promise(() => {}) }));
jest.unstable_mockModule("../src/utils/spawn-helper.cjs", () => ({ silentSpawn, transparentSpawn: jest.fn(), muteTSpawn: jest.fn() }));

let J: typeof import("../src/utils/judge.js");
beforeAll(async () => { J = await import("../src/utils/judge.js"); });
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("prompt without an invocation condition", () => {
  it("is always game mode and never asks the judge", async () => {
    const f = mockFetch(() => { throw new Error("no call expected"); });
    expect(await J.decideMode("Tell me a joke")).toBe("game");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("GPU judge instance with defaults", () => {
  it("does not hide the GPU, uses port 11435 and the inherited models dir", async () => {
    let n = 0;
    mockFetch((url) => (url.endsWith("/api/version") && n++ === 0 ? new Response("", { status: 503 }) : jsonResponse({})));
    await J.startJudgeInstance();
    const env = silentSpawn.mock.calls[0][2] as NodeJS.ProcessEnv;
    expect(env.OLLAMA_HOST).toBe("127.0.0.1:11435");
    expect(env.OLLAMA_CONTEXT_LENGTH).toBe("8192");
    expect(env.OLLAMA_MODELS).toBe("/data/models");
    expect(env.CUDA_VISIBLE_DEVICES).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith("Judge instance on 127.0.0.1:11435 (GPU, ctx 8192)");
  });
});
