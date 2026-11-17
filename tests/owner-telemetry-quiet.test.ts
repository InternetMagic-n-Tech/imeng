import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/owner-quiet"); // telemetry.notice "never"
process.env.MLFLOW_TRACKING_URI = "http://mlflow.test:5000";
process.env.MLFLOW_EXPERIMENT_ID = "7";
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { flushMlflow } = await import("../src/utils/mlflow.js");

const ollama = makeOllama();
const modelFetch = globalThis.fetch;
beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  globalThis.fetch = (async (url: string, init?: RequestInit) => String(url).startsWith("http://mlflow.test:5000") ? new Response("{}") : modelFetch(url as never, init)) as typeof fetch;
});
afterEach(() => { jest.restoreAllMocks(); globalThis.fetch = modelFetch; });

describe("telemetry.notice never", () => {
  it("says nothing, even when telemetry is on", async () => {
    const t = makeChat(app, "q");
    expect(await t.send({ id: "u-bea", name: "Bea" }, "Let's play")).toBe("The torch flickers.");
    await sessions.get("chat:q")!.tail; await flushLogs(); await flushMlflow();
  });
});
