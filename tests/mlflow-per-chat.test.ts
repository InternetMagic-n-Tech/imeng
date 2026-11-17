import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.MLFLOW_TRACKING_URI = "http://mlflow.test:5000/";
process.env.MLFLOW_EXPERIMENT_PER_CHAT = "1";
delete process.env.MLFLOW_EXPERIMENT_ID;

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { flushMlflow } = await import("../src/utils/mlflow.js");
const { _resetChatExperiments, chatExperimentId } = await import("../src/utils/mlflow-chat.js");

const ollama = makeOllama();
const seen: { url: string; headers: Record<string, string> }[] = [];
let known = new Map<string, string>();
let adminDown = false;
const modelFetch = globalThis.fetch;
beforeEach(() => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "asks to play" }; ollama.s.setup = { rules: [], actors: [] };
  sessions.clear(); seen.length = 0; known = new Map(); adminDown = false; _resetChatExperiments();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("http://mlflow.test:5000")) return modelFetch(url as never, init);
    if (adminDown && u.includes("/api/2.0/")) throw new TypeError("fetch failed");
    if (u.includes("/experiments/get-by-name")) { const n = new URL(u).searchParams.get("experiment_name")!; return known.has(n) ? new Response(JSON.stringify({ experiment: { experiment_id: known.get(n) } })) : new Response(JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST" }), { status: 404 }); }
    if (u.includes("/experiments/create")) { const n = JSON.parse(String(init!.body)).name; known.set(n, String(40 + known.size)); return new Response(JSON.stringify({ experiment_id: known.get(n) })); }
    seen.push({ url: u, headers: init!.headers as Record<string, string> });
    return new Response("{}");
  }) as typeof fetch;
});
const chat = (id: string) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).set("x-openwebui-user-id", "u-7").send({ messages: [{ role: "user", content: "Game: Test Adventure" }] });
const settle = async (id: string) => { await sessions.get("chat:" + id)!.tail; await flushLogs(); await flushMlflow(); };

describe("each chat is its own MLflow experiment", () => {
  it("creates one named after the model, time zone and session, and sends the chat's traces to it", async () => {
    await chat("a1"); await settle("a1");
    await chat("b2"); await settle("b2");
    const names = [...known.keys()];
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^gemma4_26b-\d{4}-\d\d-\d\d-\d{6}-T-.+-chat_a1$/);
    const ids = seen.filter((s) => s.url.endsWith("/v1/traces")).map((s) => s.headers["x-mlflow-experiment-id"]);
    expect(ids).toEqual(["40", "41"]);
  });
  it("reuses a session's experiment, and a failure to create one never touches the game", async () => {
    expect(await chatExperimentId("s1", "m")).toBe("40");
    expect(await chatExperimentId("s1", "m")).toBe("40");
    expect(known.size).toBe(1);
    adminDown = true;
    const res = await chat("c3"); await settle("c3");
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });
  it("does nothing when off or without a session", async () => {
    expect(await chatExperimentId("s", "m", undefined, false)).toBeNull();
    expect(await chatExperimentId("", "m")).toBeNull();
  });
});
