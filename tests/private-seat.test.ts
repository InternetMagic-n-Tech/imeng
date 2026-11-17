import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge-seat"); // private.unseated: seat

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const KEY = "chat:" + TABLE;
const post = (id: string, name: string, messages: unknown[]) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", TABLE).set("x-openwebui-user-id", id).set("x-openwebui-user-name", name).send({ messages });
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("private.unseated: seat", () => {
  it("seats the newcomer and files the note", async () => {
    const log: { role: string; content: string }[] = [{ role: "user", content: "Let's play" }];
    await post("u-bea", "Bea", log); await settle();
    log.push({ role: "assistant", content: "The torch flickers." }, { role: "user", content: "I watch" });
    await post("u-bo", "Bo", log); await settle();
    log.push({ role: "assistant", content: "The torch flickers." }, { role: "user", content: "<private>I am new here</private>" });
    const r = await post("u-cy", "Cy", log);
    expect(r.body.choices[0].message.content).toContain("Noted: the DM will weigh it");
    expect(sessions.get(KEY)!.room!.players["u-cy"]).toBeDefined();
    expect(sessions.get(KEY)!.room!.notes!.map((n) => n.text)).toContain("I am new here");
  });
});
