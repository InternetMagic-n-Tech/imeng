import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge-tools"); // as knowledge, with the tool loop on

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { toolsOn } = await import("../src/utils/tools.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const KEY = "chat:" + TABLE;
const log: { role: string; content: string }[] = [];
const send = async (who: { id: string; name: string }, text: string) => {
  log.push({ role: "user", content: text });
  const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", TABLE).set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", who.name)
    .send({ model: "knowledge", stream: false, messages: [...log] });
  const content = res.body?.choices?.[0]?.message?.content;
  if (typeof content === "string") log.push({ role: "assistant", content });
  return res;
};
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset();
  log.length = 0;
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("the leak guard on the tool-calling narrator path", () => {
  it("holds, rewrites and audits a leak the same way when the tools are on", async () => {
    expect(toolsOn()).toBe(true);
    await send(bea, "Let's play"); await settle();
    await send(bo, "I watch"); await settle();
    ollama.s.calls.length = 0;
    ollama.s.narrations.push("The brother says he will sell the farm.", "The brother stares at his boots.");
    const res = await send(bea, "I ask the brother what he thinks");
    expect(res.body.choices[0].message.content).toBe("The brother stares at his boots.");
    await settle();
    expect(sessions.get(KEY)!.knowledge!.audit.map((a) => a.kind)).toEqual(expect.arrayContaining(["leak", "leak-retried"]));
  });
});
