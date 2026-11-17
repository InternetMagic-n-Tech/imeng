import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

// Docker-style setup: no spawning (JUDGE_INSTANCE=off), the judge lives on the host at JUDGE_URL.
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/alt"); // judge_instance.num_ctx = 4096
process.env.JUDGE_INSTANCE = "off";
process.env.JUDGE_URL = "http://host.docker.internal:11435/"; // trailing slash is tolerated

let J: typeof import("../src/utils/judge.js");
beforeAll(async () => { J = await import("../src/utils/judge.js"); });
beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); });

describe("judge on a remote Ollama (JUDGE_URL)", () => {
  it("sends judge calls to that address, keeps the model loaded and uses the configured context size", async () => {
    const f = mockFetch(() => jsonResponse({ message: { content: '{"ok":true}' } }));
    expect(await J.judgeJSON("s", "u")).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host.docker.internal:11435/api/chat");
    const body = JSON.parse(String(init.body));
    expect(body.keep_alive).toBe(-1);
    expect(body.options.num_ctx).toBe(4096);
  });

  it("does not spawn anything when JUDGE_INSTANCE is off", async () => {
    const f = mockFetch(() => { throw new Error("no call expected"); });
    expect(await J.startJudgeInstance()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
