import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

// A "public" configuration: API key required, debug endpoint off.
process.env.PROXY_API_KEY = "s3cret";
process.env.ENABLE_DEBUG = "0";
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

const body = { messages: [{ role: "user", content: "Game: Test Adventure" }] };

describe("public configuration", () => {
  it("rejects unauthenticated model-list and chat requests, before touching Ollama", async () => {
    expect((await request(app).get("/v1/models")).status).toBe(401);
    expect((await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "k1").send(body)).status).toBe(401);
    expect((await request(app).post("/v1/chat/completions").set("Authorization", "Bearer wrong").send(body)).status).toBe(401);
    expect(ollama.s.calls).toHaveLength(0);
  });

  it("serves requests that carry the key", async () => {
    const auth = { Authorization: "Bearer s3cret" };
    expect((await request(app).get("/v1/models").set(auth)).status).toBe(200);
    const res = await request(app).post("/v1/chat/completions").set(auth).set("x-openwebui-chat-id", "k2").send(body);
    expect(res.status).toBe(200);
    await sessions.get("chat:k2")!.tail;
  });

  it("does not expose the debug endpoint at all", async () => {
    expect((await request(app).get("/debug/state")).status).toBe(404);
    expect((await request(app).get("/debug/state").set("Authorization", "Bearer s3cret")).status).toBe(404);
  });

  it("does not advertise Express", async () => {
    const res = await request(app).get("/v1/models").set("Authorization", "Bearer s3cret");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
