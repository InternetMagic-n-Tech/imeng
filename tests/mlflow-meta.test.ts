import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.MLFLOW_TRACKING_URI = "http://mlflow.test:5000";
process.env.MLFLOW_EXPERIMENT_ID = "7"; // MLFLOW_CAPTURE not set: the default is meta

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { flushMlflow } = await import("../src/utils/mlflow.js");

const ollama = makeOllama();
const bodies: string[] = [];
const modelFetch = globalThis.fetch;

beforeEach(() => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "asks to play" }; ollama.s.setup = { rules: [], actors: [] };
  sessions.clear(); bodies.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("http://mlflow.test:5000")) { bodies.push(String(init!.body)); return new Response("{}", { status: 200 }); }
    return modelFetch(url as never, init);
  }) as typeof fetch;
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("MLFLOW_CAPTURE=meta (default)", () => {
  it("sends timings, models and counts, but no prompt, player or narration text", async () => {
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "meta").send({ messages: [{ role: "user", content: "Game: Test Adventure" }] });
    await sessions.get("chat:meta")!.tail; await flushLogs(); await flushMlflow();
    expect(bodies).toHaveLength(1);
    const text = bodies[0];
    expect(text).not.toContain("You are the narrator");
    expect(text).not.toContain("The torch flickers");
    expect(text).not.toContain("Game: Test Adventure");
    expect(text).not.toContain("spanInputs");
    expect(text).not.toContain("spanOutputs");
    expect(text).toContain("prompt.chars");
    expect(text).toContain("gen_ai.request.model");
  });
});
