import { describe, it, expect, beforeAll } from "@jest/globals";
import path from "node:path";
import { fakeRes, jsonResponse, mockFetch, sseChunks, sseResponse } from "./helpers.js";
import type { Response as ExpressResponse } from "express";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/scrub"); // hide_state_echo: true
let relay: typeof import("../src/utils/upstream.js").relay;
beforeAll(async () => { ({ relay } = await import("../src/utils/upstream.js")); });
const asExpress = (r: ReturnType<typeof fakeRes>) => r as unknown as ExpressResponse;

describe("relay hides echoed server state (narrator only)", () => {
  const echo = "Welcome!\n\n## CURRENT GAME STATE (authoritative)\n```json\n{\"actors\": {}}\n```\nNever contradict this.\n\nOn with the show.";
  it("streaming: strips the block from the client stream and from the returned narration", async () => {
    mockFetch(() => sseResponse(sseChunks(echo)));
    const res = fakeRes();
    const text = await relay(asExpress(res), { stream: true });
    const out = res.written.join("");
    expect(text).toBe("Welcome!\n\nOn with the show.");
    expect(out).not.toContain("CURRENT GAME STATE");
    expect(out).not.toContain("actors");
    expect(out).toContain("data: [DONE]");
  });
  it("streaming: text held at the very end is still delivered before [DONE]", async () => {
    mockFetch(() => sseResponse(sseChunks("Done.\n# Finale")));
    const res = fakeRes();
    const text = await relay(asExpress(res), { stream: true });
    const out = res.written.join("");
    expect(text).toBe("Done.\n# Finale");
    expect(out.indexOf("Finale")).toBeGreaterThan(-1);
    expect(out.indexOf("Finale")).toBeLessThan(out.indexOf("[DONE]"));
  });
  it("non-streaming: strips the block from the reply", async () => {
    mockFetch(() => jsonResponse({ choices: [{ message: { content: echo } }] }));
    const res = fakeRes();
    const text = await relay(asExpress(res), { stream: false });
    expect(text).toBe("Welcome!\n\nOn with the show.");
  });
  it("other roles are left alone", async () => {
    mockFetch(() => jsonResponse({ choices: [{ message: { content: echo } }] }));
    expect(await relay(asExpress(fakeRes()), { stream: false }, "direct")).toBe(echo);
  });
});
