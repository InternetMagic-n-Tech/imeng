import { describe, it, expect, beforeAll } from "@jest/globals";
import path from "node:path";
import { fakeRes, jsonResponse, mockFetch, sseChunks, sseResponse } from "./helpers.js";
import type { Response as ExpressResponse } from "express";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/plain"); // reasoning: "show"
let relay: typeof import("../src/utils/upstream.js").relay;
beforeAll(async () => { ({ relay } = await import("../src/utils/upstream.js")); });

describe("relay with reasoning: show", () => {
  it("forwards reasoning chunks untouched when streaming", async () => {
    mockFetch(() => sseResponse(sseChunks("Hi there")));
    const res = fakeRes();
    const text = await relay(res as unknown as ExpressResponse, { stream: true });
    expect(text).toBe("Hi there");
    expect(res.written.join("")).toContain('"reasoning":"hmm"');
  });

  it("keeps reasoning in non-streamed replies", async () => {
    mockFetch(() => jsonResponse({ choices: [{ message: { content: "Hi", reasoning: "thinking" } }] }));
    const res = fakeRes();
    await relay(res as unknown as ExpressResponse, {});
    expect((res.body as any).choices[0].message.reasoning).toBe("thinking");
  });
});
