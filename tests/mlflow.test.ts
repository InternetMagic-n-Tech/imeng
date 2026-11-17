import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.MLFLOW_TRACKING_URI = "http://mlflow.test:5000/";
process.env.MLFLOW_EXPERIMENT_ID = "7";
process.env.MLFLOW_RUN_ID = "run-1";
process.env.MLFLOW_TRACKING_TOKEN = "tok";
process.env.MLFLOW_CAPTURE = "full";

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { flushMlflow, otlpValue } = await import("../src/utils/mlflow.js");

const ollama = makeOllama();
interface Sent { url: string; headers: Record<string, string>; body: any }
let sent: Sent[] = [];
let mlflowDown = false;
const modelFetch = globalThis.fetch;
const intercept = () => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("http://mlflow.test:5000")) {
      sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      if (mlflowDown) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }
    return modelFetch(url as never, init);
  }) as typeof fetch;
};
const chat = (id: string, text = "Game: Test Adventure") => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).set("x-openwebui-user-id", "u-7").send({ messages: [{ role: "user", content: text }] });
const spans = (s: Sent): any[] => s.body.resourceSpans[0].scopeSpans[0].spans;
const attr = (span: any, key: string): any => { const a = span.attributes.find((x: any) => x.key === key); return a && (a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue ?? a.value); };

beforeEach(() => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "asks to play" }; ollama.s.setup = { rules: [], actors: [] };
  sessions.clear(); sent = []; mlflowDown = false; intercept();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("otlpValue", () => {
  it("encodes JS values the way OTLP/JSON wants (64-bit integers as strings)", () => {
    expect(otlpValue("a")).toEqual({ stringValue: "a" });
    expect(otlpValue(3)).toEqual({ intValue: "3" });
    expect(otlpValue(1.5)).toEqual({ doubleValue: 1.5 });
    expect(otlpValue(true)).toEqual({ boolValue: true });
    expect(otlpValue([1, "x"])).toEqual({ arrayValue: { values: [{ intValue: "1" }, { stringValue: "x" }] } });
    expect(otlpValue({ a: 1, b: undefined })).toEqual({ kvlistValue: { values: [{ key: "a", value: { intValue: "1" } }] } });
  });
});

describe("one trace per game turn", () => {
  it("keeps personal details out of what a full capture sends", async () => {
    ollama.s.narration = "Noted: bea@example.com, card 4111 1111 1111 1111.";
    const res = await chat("m-pii", "Game: Test Adventure, my mail is bea@example.com and password=hunter2hunter2");
    expect(res.status).toBe(200);
    await sessions.get("chat:m-pii")!.tail; await flushLogs(); await flushMlflow();
    const text = JSON.stringify(sent.map((x) => x.body));
    expect(text).not.toContain("bea@example.com");
    expect(text).not.toContain("4111 1111");
    expect(text).not.toContain("hunter2");
    expect(text).toMatch(/\[(email|card|secret):[0-9a-f]{6}\]/);
    ollama.s.narration = "The torch flickers.";
  });

  it("sends a root span and a span per model call to MLflow's OTLP endpoint", async () => {
    ollama.s.extractor.push([{ op: "set", path: "game.location", value: "cave" }]);
    const res = await chat("m1");
    expect(res.status).toBe(200);
    await sessions.get("chat:m1")!.tail; await flushLogs(); await flushMlflow();

    expect(sent).toHaveLength(1);
    const [x] = sent;
    expect(x.url).toBe("http://mlflow.test:5000/v1/traces");
    expect(x.headers).toMatchObject({ "Content-Type": "application/json", "x-mlflow-experiment-id": "7", "x-mlflow-run-id": "run-1", Authorization: "Bearer tok" });

    const all = spans(x);
    const root = all.find((s) => !s.parentSpanId)!;
    expect(root.name).toBe("turn 1");
    expect(all.filter((s) => !s.parentSpanId)).toHaveLength(1);
    expect(new Set(all.map((s) => s.traceId)).size).toBe(1);
    for (const s of all) {
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
      if (s.parentSpanId) expect(s.parentSpanId).toBe(root.spanId);
    }
    expect(attr(root, "mlflow.spanType")).toBe("CHAIN");
    expect(attr(root, "session.id")).toBe("chat:m1");
    expect(attr(root, "user.id")).toBe("u-7");
    expect(attr(root, "mlflow.traceTag.game")).toBe("test-game");
    expect(attr(root, "mlflow.spanInputs")).toBe("Game: Test Adventure");
    expect(attr(root, "mlflow.spanOutputs")).toBe("The torch flickers.");
    expect(BigInt(root.startTimeUnixNano) <= BigInt(all.find((s) => s.name === "narrator")!.startTimeUnixNano)).toBe(true);

    const names = all.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["narrator", "extractor", "state.apply"]));
    const narrator = all.find((s) => s.name === "narrator")!;
    expect(attr(narrator, "mlflow.spanType")).toBe("LLM");
    expect(attr(narrator, "gen_ai.request.model")).toBe("gemma4:26b");
    expect(attr(narrator, "mlflow.spanOutputs")).toBe("The torch flickers.");
    const input = narrator.attributes.find((a: any) => a.key === "mlflow.spanInputs").value.kvlistValue.values[0];
    expect(input.key).toBe("messages");
    expect(JSON.stringify(input.value)).toContain("You are the narrator of a test game.");
    const apply = all.find((s) => s.name === "state.apply")!;
    expect(attr(apply, "ops.applied")).toBe("1");
    expect(attr(apply, "ops.skipped")).toBe("0");
    expect(x.body.resourceSpans[0].resource.attributes).toEqual(expect.arrayContaining([{ key: "service.name", value: { stringValue: "imeng" } }]));
  });

  it("each turn is its own trace", async () => {
    await chat("m2");
    await sessions.get("chat:m2")!.tail;
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "m2").send({ messages: [{ role: "user", content: "Game: Test Adventure" }, { role: "assistant", content: "The torch flickers." }, { role: "user", content: "I go on" }] });
    await sessions.get("chat:m2")!.tail; await flushLogs(); await flushMlflow();
    expect(sent).toHaveLength(2);
    expect(spans(sent[0])[0].traceId).not.toBe(spans(sent[1])[0].traceId);
    expect(spans(sent[1]).find((s) => !s.parentSpanId).name).toBe("turn 2");
  });

  it("direct (non-game) chats are never sent", async () => {
    ollama.s.invoke = { invoked: false, reason: "no" };
    await chat("m3", "what is the capital of France?");
    await sessions.get("chat:m3")!.tail; await flushLogs(); await flushMlflow();
    expect(sent).toHaveLength(0);
  });

  it("a failing MLflow never touches the game, and is reported once", async () => {
    mlflowDown = true;
    const res = await chat("m4");
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain("The torch flickers.");
    await sessions.get("chat:m4")!.tail; await flushLogs(); await flushMlflow();
    expect(sent.length).toBeGreaterThan(0);
    expect((console.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).startsWith("mlflow export failed"))).toHaveLength(1);
    expect(sessions.get("chat:m4")!.snapshots.at(-1)!.game.turn).toBe(1);
  });
});
