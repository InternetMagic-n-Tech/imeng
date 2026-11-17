import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/goals-table");

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
type Who = { id: string; name: string };
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", PRIV = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const KEY = "chat:" + TABLE;
const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return { send: async (who: Who, text: string) => {
    log.push({ role: "user", content: text });
    const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", who.name).send({ messages: log });
    const content = res.body?.choices?.[0]?.message?.content;
    if (typeof content === "string") log.push({ role: "assistant", content });
    return res;
  } };
};
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };
let table: ReturnType<typeof chat>, priv: ReturnType<typeof chat>;
const start = async () => {
  table = chat(TABLE); priv = chat(PRIV);
  await table.send(bea, "Let's play"); await settle();
  await table.send(bo, "I watch"); await settle();
  ollama.s.calls.length = 0;
};
beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("goals at a table", () => {
  it("a private note the judge reads as a goal is written down: no narrator, nothing at the table", async () => {
    await start();
    ollama.s.goalReads.push({ goal: "get covered in pink gak" });
    const r = await priv.send(bea, "I really want to be covered in pink gak");
    expect(reply(r)).toContain("Written in the Notebook: get covered in pink gak");
    expect(ollama.calls("narrator")).toHaveLength(0);
    const s = sessions.get(KEY)!;
    expect(s.goals!.goals[0]).toMatchObject({ actor: "user", text: "get covered in pink gak" });
    expect(s.snapshots.at(-1)!.actors.user.goals_set).toBe(1);
    expect(JSON.stringify(s.room)).not.toContain("pink gak"); // not a note for the narrator either
  });
  it("a spoken message with a private reason is captured as a goal with a reason; the round goes on and no note is queued", async () => {
    await start();
    ollama.s.goalReads.push({ goal: "not get any gak on me", reason: "a new tattoo that burns" });
    await table.send(bea, "I do not want any gak <private>because I have a new tattoo that burns</private>"); await settle();
    const s = sessions.get(KEY)!;
    expect(s.goals!.goals.find((g) => g.actor === "user")).toMatchObject({ text: "not get any gak on me", reason: "a new tattoo that burns" });
    expect(JSON.stringify(s.room)).not.toContain("tattoo");
  });
  it("a private note that is not a goal goes the usual way", async () => {
    await start();
    const r = await priv.send(bea, "I distrust Bo");
    expect(reply(r)).toContain("Noted");
    expect(sessions.get(KEY)!.goals?.goals ?? []).toHaveLength(0);
  });
  it("stops reading once the person is at their maximum", async () => {
    await start();
    ollama.s.goalReads.push({ goal: "one" });
    await priv.send(bea, "one");
    await priv.send(bea, "something else");
    expect(ollama.calls("goal_read")).toHaveLength(1);
  });
  it("says it could not read a note when the judge is down, and keeps nothing", async () => {
    await start();
    ollama.s.judgeDown = true;
    const r = await priv.send(bea, "I want pink gak");
    expect(reply(r)).toContain("could not read that just now");
    expect(sessions.get(KEY)!.goals?.goals ?? []).toHaveLength(0);
  });
  it("/goal at the table itself is refused (it would be read by everyone), in the private chat it works, and /goals shows only your own", async () => {
    await start();
    expect(reply(await table.send(bea, "/goal pink gak"))).toContain("Goals are private");
    expect(sessions.get(KEY)!.goals?.goals ?? []).toHaveLength(0);
    expect(reply(await priv.send(bea, "/goal pink gak"))).toContain("Written in the Notebook");
    expect(reply(await priv.send(bea, "/goals"))).toContain("pink gak (not yet)");
    const bochat = chat("cccccccc-3333-4333-8333-cccccccccccc");
    await bochat.send(bo, "hello"); // Bo's own private chat
    expect(reply(await bochat.send(bo, "/goals"))).not.toContain("pink gak");
  });
  it("a blind host never sees a goal or the counters", async () => {
    await start();
    await priv.send(bea, "/goal pink gak");
    await table.send(bea, "I look around"); await settle();
    const p = JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
    expect(p).not.toContain("pink gak");
    expect(p).not.toContain("goals_set");
    expect(p).not.toContain("SECRET GOALS");
  });
});
