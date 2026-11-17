import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/naming");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

describe("reserved names reach the narrator", () => {
  it("tells the narrator the next names to use and keeps them on the session", async () => {
    ollama.s.narration = "ok"; ollama.s.extractor.push([]);
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "n1").send({ messages: [{ role: "user", content: "hello" }] });
    await sessions.get("chat:n1")!.tail;
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).toContain("NAMES FOR NEW CHARACTERS");
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).toMatch(/Priya, Marcus/);
    expect(sessions.get("chat:n1")!.namePool!.length).toBe(3);
  });
});
