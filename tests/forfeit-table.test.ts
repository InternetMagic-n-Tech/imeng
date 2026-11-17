import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-forfeit");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" };
const TABLE = "dddddddd-4444-4444-8444-dddddddddddd", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The lights flicker.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("a forfeit at a table (through the app)", () => {
  it("is dealt after a narrated round, and the player's picture pays it without a model seeing it", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "I follow her in"); await settle();
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    const s = sessions.get(KEY)!;
    const owed = (s.snapshots.at(-1)!.game as any).forfeit as { actor: string } | undefined;
    expect(owed).toBeTruthy();
    const who = Object.entries(s.room!.players).find(([, p]) => p.actor === owed!.actor)![0];
    const log = [...t.log, { role: "user", content: [{ type: "text", text: "here is my face" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }];
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", TABLE).set("x-openwebui-user-id", who).set("x-openwebui-user-name", encodeURIComponent(who === bea.id ? "Bea" : "Bo")).send({ messages: log });
    await settle();
    expect((sessions.get(KEY)!.snapshots.at(-1)!.game as any).forfeit).toBeUndefined();
  });
});
