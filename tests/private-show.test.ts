import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/private");
process.env.SHOW_PRIVATE = "1";
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

describe("SHOW_PRIVATE=1 (debugging)", () => {
  it("leaves <private> blocks in the reply", async () => {
    ollama.s.narration = "The Host smiles. <private>note</private>";
    const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "s1").send({ messages: [{ role: "user", content: "hi" }] });
    expect(r.body.choices[0].message.content).toBe("The Host smiles. <private>note</private>");
    await sessions.get("chat:s1")!.tail;
  });
});
