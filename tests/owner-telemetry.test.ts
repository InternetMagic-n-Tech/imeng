import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";
import type { Who } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/owner");
process.env.MLFLOW_TRACKING_URI = "http://mlflow.test:5000";
process.env.MLFLOW_EXPERIMENT_ID = "7";
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { flushMlflow } = await import("../src/utils/mlflow.js");

const ollama = makeOllama();
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const KEY = "chat:tel";
const sent: string[] = [];
const modelFetch = globalThis.fetch;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); await flushMlflow(); };
const ON = "Note: this game sends traces of its model calls to an MLflow server for debugging.";

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear(); sent.length = 0;
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("http://mlflow.test:5000")) { sent.push(String(url)); return new Response("{}"); }
    return modelFetch(url as never, init);
  }) as typeof fetch;
});
afterEach(() => { jest.restoreAllMocks(); globalThis.fetch = modelFetch; });

describe("telemetry disclosure and /telemetry", () => {
  it("says so on the first reply and not again", async () => {
    const t = makeChat(app, "tel");
    expect(await t.send(bea, "Let's play")).toBe(`The torch flickers.\n\n${ON}`);
    await settle();
    expect(sent.length).toBeGreaterThan(0);
    expect(await t.send(bea, "I look")).toBe("The torch flickers.");
    await settle();
  });

  it("only the owner can turn it off; the change is told, nothing more is sent, and the record stays", async () => {
    const t = makeChat(app, "tel");
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "Hi"); await settle();
    expect(await t.send(bo, "/telemetry off")).toBe("Only the owner, Bea, can do that.");
    expect(await t.send(bo, "/telemetry")).toBe("Telemetry is on.");
    const off = await t.send(bea, "/telemetry off");
    expect(off).toBe("Note: telemetry is now off for this chat (the owner chose it). Nothing more is sent to MLflow; what was recorded before is kept.");
    sent.length = 0;
    expect(await t.send(bea, "I look")).toBe("The torch flickers."); // already told
    await settle();
    expect(sent).toEqual([]);
    expect(sessions.get(KEY)!.snapshots.length).toBeGreaterThan(2); // the game record is untouched
  });

  it("turning it on again is told with the reason, and traces resume", async () => {
    const t = makeChat(app, "tel");
    await t.send(bea, "Let's play"); await settle();
    await t.send(bea, "/telemetry off");
    expect(await t.send(bea, "/telemetry on")).toBe("Note: telemetry is on again for this chat (the owner chose it). Traces of its model calls go to an MLflow server.");
    sent.length = 0;
    expect(await t.send(bea, "I look")).toBe("The torch flickers.");
    await settle();
    expect(sent.length).toBeGreaterThan(0);
  });

  it("remembers what the players were told", async () => {
    const t = makeChat(app, "tel");
    await t.send(bea, "Let's play"); await settle();
    expect(sessions.get(KEY)!.own!.disclosed).toBe("on");
  });
});
