import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/guard-tokens");
process.env.CONTEXT_MAX_TOKENS = "2000";
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
let cfg: typeof import("../src/utils/config.js");

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
  cfg = await import("../src/utils/config.js");
});
beforeEach(() => {
  ollama.reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const post = (id: string, content: string) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content }] });

describe("CONTEXT_MAX_TOKENS (the machine guard)", () => {
  it("refuses an over-large message with a 413 and the game's own wording, before any model is called", async () => {
    ollama.s.calls.length = 0;
    const r = await post("g1", "word ".repeat(6000));
    expect(r.status).toBe(413);
    expect(r.body.error.message).toBe("Too much text! Shorten it.");
    expect(ollama.calls("narrator")).toHaveLength(0);
    expect(ollama.s.calls).toHaveLength(0);
    expect(sessions.get("chat:g1")?.snapshots.length ?? 0).toBeLessThanOrEqual(1);
  });
  it("lets a normal message through, and the same chat works after a refusal", async () => {
    expect((await post("g2", "word ".repeat(6000))).status).toBe(413);
    const ok = await post("g2", "hello");
    expect(ok.status).toBe(200);
    expect(ollama.calls("narrator")).toHaveLength(1);
  });
  it("reads actor_history_limit before the old history_limit", () => {
    expect(cfg.HISTORY_LIMIT).toBe(3);
    expect(cfg.CONTEXT_MAX_TOKENS).toBe(2000);
  });
});
