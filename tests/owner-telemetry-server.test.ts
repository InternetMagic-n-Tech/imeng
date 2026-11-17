import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/owner");
process.env.MLFLOW_TRACKING_URI = "http://mlflow.test:5000";
process.env.MLFLOW_EXPERIMENT_ID = "7";
process.env.TELEMETRY = "off";
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" };
const settle = async () => { await sessions.get("chat:srv")!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.TELEMETRY; });

describe("TELEMETRY=off on the server", () => {
  it("says nothing on a fresh chat and cannot be turned on by the owner", async () => {
    const t = makeChat(app, "srv");
    expect(await t.send(bea, "Let's play")).toBe("The torch flickers.");
    await settle();
    expect(await t.send(bea, "/telemetry on")).toBe("Telemetry is off for the whole server; the owner cannot turn it on.");
  });

  it("a chat that was told telemetry was on is told when the server has turned it off", async () => {
    const t = makeChat(app, "srv");
    await t.send(bea, "Let's play"); await settle();
    sessions.get("chat:srv")!.own!.disclosed = "on";
    expect(await t.send(bea, "I look")).toBe("The torch flickers.\n\nNote: telemetry is now off for this chat (the server setting). Nothing more is sent to MLflow; what was recorded before is kept.");
    expect(await t.send(bea, "I look again")).toBe("The torch flickers.");
  });
});
