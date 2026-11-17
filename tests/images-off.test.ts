import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
beforeAll(async () => { ({ app } = await import("../src/app.js")); });
beforeEach(() => { ollama.reset(); jest.spyOn(console, "log").mockImplementation(() => {}); });

describe("images are off unless config.json has an images block", () => {
  it("treats /draw as ordinary text and serves no pictures", async () => {
    const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "off1").send({ messages: [{ role: "user", content: "/draw a door" }] });
    expect(r.status).toBe(200);
    expect(ollama.calls("narrator").length + ollama.calls("invocation").length).toBeGreaterThan(0);
    expect((await request(app).get("/images/" + "0".repeat(24) + ".png")).status).toBe(404);
  });
});
