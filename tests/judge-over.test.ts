import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { jsonResponse } from "./helpers.js";

const { judgeOver } = await import("../src/utils/goals-config.js");
const { judgeJSON } = await import("../src/utils/judge.js");

describe("judgeOver", () => {
  const keep = { ...process.env };
  afterEach(() => { process.env = { ...keep }; });
  it("is undefined without any setting, and reads the game's setting", () => {
    expect(judgeOver(undefined, "GOALS")).toBeUndefined();
    expect(judgeOver({ model: "big", url: "http://h:1", api: "openai", num_ctx: 8192 }, "GOALS")).toEqual({ model: "big", url: "http://h:1", api: "openai", numCtx: 8192 });
  });
  it("lets the environment win", () => {
    process.env.GOALS_JUDGE_MODEL = "env-model"; process.env.GOALS_JUDGE_URL = "http://env:2"; process.env.GOALS_JUDGE_API = "ollama";
    expect(judgeOver({ model: "big", url: "http://h:1", api: "openai" }, "GOALS")).toMatchObject({ model: "env-model", url: "http://env:2", api: "ollama" });
  });
});

describe("judgeJSON with its own judge", () => {
  const calls: { url: string; body: any }[] = [];
  beforeEach(() => {
    calls.length = 0;
    jest.spyOn(console, "log").mockImplementation(() => {});
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      return url.endsWith("/api/chat") ? jsonResponse({ message: { content: '{"ok":1}' } }) : jsonResponse({ choices: [{ message: { content: '{"ok":2}' } }] });
    });
  });
  it("asks another model at another address (Ollama)", async () => {
    expect(await judgeJSON("s", "c", "x", 50, { model: "big", url: "http://big:11434/" })).toEqual({ ok: 1 });
    expect(calls[0].url).toBe("http://big:11434/api/chat");
    expect(calls[0].body.model).toBe("big");
  });
  it("asks an OpenAI-compatible server", async () => {
    expect(await judgeJSON("s", "c", "x", 50, { model: "big", url: "http://big:8080/v1", api: "openai", numCtx: 4096 })).toEqual({ ok: 2 });
    expect(calls[0].url).toBe("http://big:8080/v1/chat/completions");
    expect(calls[0].body.model).toBe("big");
  });
  it("keeps its usual model when nothing is overridden", async () => {
    await judgeJSON("s", "c");
    expect(calls[0].body.model).not.toBe("big");
  });
});
