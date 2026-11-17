import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import request from "supertest";
import { app } from "../src/app.js";
import { sessions } from "../src/utils/sessions.js";
import { makeOllama } from "./fake-ollama.js";
import { ollamaFacade } from "../src/modules/openwebui/ollama.js";

const ollama = makeOllama();
beforeEach(() => {
  ollama.reset();
  ollama.s.invoke = { invoked: true, reason: "asks to play" };
  ollama.s.setup = { rules: [], actors: [] };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("an Ollama connection pointed at the proxy", () => {
  it("answers the model list, version, ps and show with the game as the only model", async () => {
    const tags = await request(app).get("/api/tags");
    expect(tags.status).toBe(200);
    expect(tags.body.models.map((m: any) => m.name)).toEqual(["test-game"]);
    expect((await request(app).get("/api/version")).body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await request(app).get("/api/ps")).body).toEqual({ models: [] });
    expect((await request(app).post("/api/show").send({ model: "test-game" })).body.capabilities).toContain("completion");
  });

  it("/api/chat streams newline-delimited JSON that ends with done:true", async () => {
    const res = await request(app).post("/api/chat").set("x-openwebui-chat-id", "ol1").send({ model: "test-game", messages: [{ role: "user", content: "Game: Test Adventure" }] }).buffer(true).parse((r, cb) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => cb(null, d)); });
    const rows = String(res.body).trim().split("\n").map((l) => JSON.parse(l));
    expect(res.headers["content-type"]).toMatch(/ndjson/);
    expect(rows.at(-1)).toMatchObject({ done: true, model: "test-game" });
    expect(rows.slice(0, -1).every((r) => r.done === false && r.message.role === "assistant")).toBe(true);
    expect(rows.map((r) => r.message.content).join("").length).toBeGreaterThan(0);
  });

  it("/api/chat with stream:false answers one JSON object", async () => {
    const res = await request(app).post("/api/chat").set("x-openwebui-chat-id", "ol2").send({ model: "test-game", stream: false, messages: [{ role: "user", content: "Game: Test Adventure" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: "test-game", done: true, message: { role: "assistant" } });
    expect(res.body.message.content.length).toBeGreaterThan(0);
  });
});

describe("ollamaFacade", () => {
  const fake = () => { const out: string[] = []; const r: any = { headersSent: false, status: () => r, set: () => r, json: (o: any) => out.push(JSON.stringify(o)), send: (b: any) => out.push(String(b)), write: (c: string) => out.push(c), end: () => out.push("END") }; return { r, out }; };
  it("splits SSE chunks that arrive in pieces and closes with one done line", () => {
    const { r, out } = fake();
    const f = ollamaFacade(r, "m", true);
    f.write('data: {"choices":[{"delta":{"content":"Hel');
    f.write('lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    f.end();
    const rows = out.filter((x) => x !== "END").map((l) => JSON.parse(l));
    expect(rows.map((x) => x.message.content).join("")).toBe("Hello there");
    expect(rows.filter((x) => x.done)).toHaveLength(1);
  });
  it("passes an error body through unchanged", () => {
    const { r, out } = fake();
    ollamaFacade(r, "m", false).json({ error: { message: "boom" } });
    expect(JSON.parse(out[0])).toEqual({ error: { message: "boom" } });
  });
  it("a non-JSON upstream body is sent as is", () => {
    const { r, out } = fake();
    ollamaFacade(r, "m", false).send("plain");
    expect(out[0]).toBe("plain");
  });
});
