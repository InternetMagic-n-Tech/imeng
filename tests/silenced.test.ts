import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-silenced"); // multiplayer on, no setup turns

const { app } = await import("../src/app.js");
const { sessions, loadSessions } = await import("../src/utils/sessions.js");
const { seats, seatOf, _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
type Who = { id: string; name: string } | null;
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" }, cy: Who = { id: "u-cy", name: "Cy" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DAY = 86_400_000;

/** One Open WebUI chat: every request carries the whole chat so far, and each reply is saved into it, as Open WebUI does. */
const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return {
    log,
    send: async (who: Who, text: string, extra: object = {}) => {
      log.push({ role: "user", content: text });
      const r = request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id);
      if (who) r.set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", encodeURIComponent(who.name));
      const res = await r.send({ messages: log, ...extra });
      const content = res.body?.choices?.[0]?.message?.content;
      if (typeof content === "string") log.push({ role: "assistant", content });
      return res;
    },
  };
};
const settle = async (key: string) => { await sessions.get(key)!.tail; await flushLogs(); };
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const narrations = () => ollama.calls("narrator").length;
const KEY = "chat:" + TABLE;
/** Bea plays alone, then Bo speaks in the same shared chat: it is a table. */
const startTable = async () => {
  const t = chat(TABLE);
  await t.send(bea, "Let's play"); await settle(KEY);
  const second = await t.send(bo, "I follow her in");
  return { t, second };
};

beforeEach(() => {
  ollama.reset();
  ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("the dead are not heard", () => {
  it("a player whose character meets silenced_when gets the fixed line: no narrator, nothing changes", async () => {
    const { t } = await startTable();
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle(KEY); // a round is played: both have characters
    const s = sessions.get(KEY)!;
    const boActor = s.room!.players[bo!.id].actor;
    s.snapshots.at(-1)!.actors[boActor].hp = 0; // Bo has died
    const before = narrations();
    const res = await t.send(bo, "I'm still here! Hello?");
    expect(reply(res)).toBe("The living do not hear you.");
    expect(narrations()).toBe(before);
    const live = await t.send(bea, "ready");
    expect(reply(live)).not.toBe("The living do not hear you.");
  });
});
