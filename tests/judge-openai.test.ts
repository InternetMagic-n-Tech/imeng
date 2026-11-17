import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/alt");
process.env.JUDGE_INSTANCE = "off";
process.env.JUDGE_API = "openai";
process.env.JUDGE_URL = "http://127.0.0.1:8081/v1/"; // a trailing /v1 is tolerated
process.env.JUDGE_API_KEY = "k";

let J: typeof import("../src/utils/judge.js");
beforeAll(async () => { J = await import("../src/utils/judge.js"); });
beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); });

describe("judge on an OpenAI-compatible server (judge_api openai)", () => {
  it("asks /v1/chat/completions in JSON mode with the key and parses the answer", async () => {
    const f = mockFetch(() => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));
    expect(await J.judgeJSON("s", "u")).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8081/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ temperature: 0, response_format: { type: "json_object" }, max_tokens: 300 });
    expect(body.options).toBeUndefined();
  });
  it("throws the server's error", async () => {
    mockFetch(() => jsonResponse({ error: { message: "model not loaded" } }));
    await expect(J.judgeJSON("s", "u")).rejects.toThrow("model not loaded");
  });
});
