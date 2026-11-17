import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

// alt fixture: invocation "always", judge_instance on port 11999 (CPU, ctx 4096, custom models dir)
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/alt");

const killed = jest.fn();
let exitPromise: Promise<unknown> = new Promise(() => {});
const silentSpawn = jest.fn((..._args: unknown[]) => ({ child: { kill: killed }, promise: exitPromise }));
jest.unstable_mockModule("../src/utils/spawn-helper.cjs", () => ({ silentSpawn, transparentSpawn: jest.fn(), muteTSpawn: jest.fn() }));

let J: typeof import("../src/utils/judge.js");
beforeAll(async () => { J = await import("../src/utils/judge.js"); });
beforeEach(() => {
  silentSpawn.mockClear(); killed.mockClear();
  exitPromise = new Promise(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("decideMode with invocation: always", () => {
  it("is always game, without asking the judge", async () => {
    const f = mockFetch(() => { throw new Error("no call expected"); });
    expect(await J.decideMode("anything at all")).toBe("game");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("startJudgeInstance", () => {
  it("spawns a CPU-only Ollama with the right environment and waits until it answers", async () => {
    let versionCalls = 0;
    const f = mockFetch((url) => {
      if (url.endsWith("/api/version")) return versionCalls++ === 0 ? new Response("", { status: 503 }) : jsonResponse({ version: "x" });
      return jsonResponse({});
    });
    await J.startJudgeInstance();

    expect(silentSpawn).toHaveBeenCalledTimes(1);
    const [exec, args, env] = silentSpawn.mock.calls[0] as [string, string[], NodeJS.ProcessEnv];
    expect(exec).toBe("ollama");
    expect(args).toEqual(["serve"]);
    expect(env).toMatchObject({
      OLLAMA_HOST: "127.0.0.1:11999", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_NUM_PARALLEL: "1",
      OLLAMA_KEEP_ALIVE: "-1", OLLAMA_CONTEXT_LENGTH: "4096", OLLAMA_MODELS: "/tmp/models",
      CUDA_VISIBLE_DEVICES: "-1", OLLAMA_VULKAN: "0",
    });
    expect(console.log).toHaveBeenCalledWith("Judge instance on 127.0.0.1:11999 (CPU, ctx 4096)");

    // the model is warmed at the new instance
    const warm = f.mock.calls.find((c) => String(c[0]).endsWith("/api/generate"))!;
    expect(String(warm[0])).toBe("http://127.0.0.1:11999/api/generate");
    expect(JSON.parse(String((warm[1] as RequestInit).body))).toEqual({ model: "j", keep_alive: -1, options: { num_ctx: 4096 } });
  });

  it("returns where the judge lives and whether it was started by this call", async () => {
    let n = 0;
    mockFetch((url) => (url.endsWith("/api/version") && n++ === 0 ? new Response("", { status: 503 }) : jsonResponse({})));
    expect(await J.startJudgeInstance()).toEqual({ base: "http://127.0.0.1:11999", spawned: true });
    mockFetch(() => jsonResponse({}));
    expect(await J.startJudgeInstance()).toEqual({ base: "http://127.0.0.1:11999", spawned: false });
  });

  it("listens on a custom address when asked (the host-side launcher binds the Docker bridge)", async () => {
    let n = 0;
    const f = mockFetch((url) => (url.endsWith("/api/version") && n++ === 0 ? new Response("", { status: 503 }) : jsonResponse({})));
    silentSpawn.mockClear();
    expect(await J.startJudgeInstance({ host: "172.17.0.1" })).toEqual({ base: "http://172.17.0.1:11999", spawned: true });
    expect((silentSpawn.mock.calls[0][2] as NodeJS.ProcessEnv).OLLAMA_HOST).toBe("172.17.0.1:11999");
    expect(String(f.mock.calls[0][0])).toBe("http://172.17.0.1:11999/api/version");
    expect(console.log).toHaveBeenCalledWith("Judge instance on 172.17.0.1:11999 (CPU, ctx 4096)");

    // restore the module's judge address for the tests that follow
    mockFetch(() => jsonResponse({}));
    await J.startJudgeInstance();
  });

  it("routes judge calls to the dedicated instance and keeps the model loaded", async () => {
    const f = mockFetch(() => jsonResponse({ message: { content: "{}" } }));
    await J.judgeJSON("s", "u");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11999/api/chat");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "j", keep_alive: -1, options: { num_ctx: 4096 } });
  });

  it("reuses an instance that is already running", async () => {
    mockFetch(() => jsonResponse({}));
    await J.startJudgeInstance();
    expect(silentSpawn).not.toHaveBeenCalled();
  });

  it("warns if warming the model fails", async () => {
    mockFetch((url) => { if (url.endsWith("/api/generate")) throw new Error("no model"); return jsonResponse({}); });
    await J.startJudgeInstance({ host: "127.0.0.1" });
    await new Promise((r) => setImmediate(r));
    expect(console.warn).toHaveBeenCalledWith("judge warmup failed:", "no model");
  });

  it("gives up (and stops the child) when the instance never comes up", async () => {
    jest.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
    exitPromise = Promise.reject(new Error("exit code 1"));
    mockFetch(() => new Response("", { status: 503 }));
    expect(await J.startJudgeInstance()).toBeNull();
    expect(killed).toHaveBeenCalledWith("SIGTERM");
    expect(console.warn).toHaveBeenCalledWith("judge ollama instance failed to start; using main instance");
    await new Promise((r) => setImmediate(r));
    expect(console.warn).toHaveBeenCalledWith("judge ollama exited:", "exit code 1");
    (setTimeout as unknown as jest.Mock).mockRestore();
  });
});
