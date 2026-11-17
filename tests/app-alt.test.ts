import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

// alt fixture: invocation "always", reasoning "off", no dice, default model id
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/alt");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("alternate game config", () => {
  it("starts a game on any first message when invocation is 'always'", async () => {
    const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "alt1")
      .send({ messages: [{ role: "user", content: "completely unrelated opener" }] });
    expect(res.status).toBe(200);
    await sessions.get("chat:alt1")!.tail;
    expect(sessions.get("chat:alt1")!.mode).toBe("game");
    expect(ollama.calls("invocation")).toHaveLength(0);
  });

  it("asks the model not to think (reasoning: off) and skips the dice block", async () => {
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "alt2")
      .send({ messages: [{ role: "user", content: "hi" }] });
    await sessions.get("chat:alt2")!.tail;
    const body = ollama.calls("narrator")[0].body;
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages[0].content).toContain("You are a narrator.");
    expect(body.messages[0].content).not.toContain("## DICE");
  });

  it("lists the default model id when config.json sets none", async () => {
    const res = await request(app).get("/v1/models");
    expect(res.body.data[0].id).toBe("text-game");
  });
});

describe("health probe", () => {
  it("answers without touching Ollama", async () => {
    const res = await request(app).get("/healthz");
    expect(res.body).toEqual({ ok: true });
    expect(ollama.s.calls).toHaveLength(0);
  });
});

describe("debug endpoint with the default (enabled) setting", () => {
  it("is available without a key when none is configured", async () => {
    const res = await request(app).get("/debug/state");
    expect(res.status).toBe(200);
  });
});
