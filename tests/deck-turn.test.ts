import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/deck");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

describe("the card draw", () => {
  it("tells the narrator a server-drawn card, and keeps the deck at 52 on the session", async () => {
    ollama.s.narration = "ok"; ollama.s.extractor.push([]);
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "k1").send({ messages: [{ role: "user", content: "I cast a spell" }] });
    await sessions.get("chat:k1")!.tail;
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).toMatch(/CARD DRAWN[\s\S]*strength x/);
    expect(sessions.get("chat:k1")!.deck!.cards.length).toBe(52);
  });
});
