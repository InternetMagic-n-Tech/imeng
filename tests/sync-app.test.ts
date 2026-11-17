import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/sync"); // sync.mode repair, replay_turns 3, batch 2

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { REFUSAL } = await import("../src/utils/sync.js");

const ollama = makeOllama();
const KEY = "chat:sync-chat";
type Msg = { role: string; content: string };

/** One Open WebUI chat: every request carries the whole chat so far; the reply is saved into it. `log` can be edited between requests, like a user editing a message. */
const chat = () => {
  const log: Msg[] = [];
  return {
    log,
    send: async (text: string) => {
      log.push({ role: "user", content: text });
      const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "sync-chat").send({ messages: log });
      const content = res.body?.choices?.[0]?.message?.content;
      if (typeof content === "string") log.push({ role: "assistant", content });
      await sessions.get(KEY)?.tail; await flushLogs();
      return res;
    },
  };
};
const narrator = (i = -1) => (ollama.calls("narrator").at(i) as any).body.messages.map((m: any) => m.content).join("\n");
const extractorUsers = () => ollama.calls("extractor").map((c: any) => c.body.messages.at(-1).content as string);

beforeEach(() => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "asks to play" }; ollama.s.setup = { rules: [], actors: [] };
  ollama.s.narration = "The torch flickers as you step into the long stone corridor. Water drips somewhere ahead, and a cold draft carries the smell of old iron toward you.";
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("a conversation that stays in step", () => {
  it("every turn saves a fingerprint and a short audit entry, and repairs nothing", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north", "I open the door"]) await c.send(t);
    const s = sessions.get(KEY)!;
    expect(s.prints).toHaveLength(3);
    expect(s.audit!.map((a) => a.kind)).toEqual(["turn", "turn", "turn"]);
    expect(s.audit!.every((a) => !JSON.stringify(a).includes("north"))).toBe(true); // no message text in the audit
    expect(s.approximate).toBeUndefined();
    expect(ollama.calls("extractor")).toHaveLength(3); // one per turn: no replay
  });

  it("the player regenerates the last reply: the record goes back, as before, and the audit says so", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north", "I open the door"]) await c.send(t);
    c.log.splice(-2); // drop the last user message and its reply, ask again
    await c.send("I knock on the door instead");
    const s = sessions.get(KEY)!;
    expect(s.audit!.map((a) => a.kind)).toEqual(["turn", "turn", "turn", "back", "turn"]);
    expect(s.snapshots).toHaveLength(4);
    expect(s.prints).toHaveLength(3);
    expect(narrator()).toContain("The player went back");
  });
});

describe("an earlier message was edited", () => {
  it("the record is rolled back to before it and the changed turns are replayed through the extractor before the turn is played", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north", "I open the door"]) await c.send(t);
    const before = ollama.calls("extractor").length;
    c.log[2].content = "I go SOUTH instead"; // the user edits turn 2 in place
    ollama.s.extractor.push([{ op: "set", path: "actors.user.name", value: "Replayed" }]); // the replay's single batch (turns 2 and 3)
    await c.send("I look around");
    const s = sessions.get(KEY)!;
    const replay = (ollama.calls("extractor") as any[]).slice(before)[0].body.messages.at(-1).content as string;
    expect(replay).toContain("I go SOUTH instead");
    expect(replay).toContain("I open the door");
    expect(narrator()).toContain("The record was corrected to match the conversation");
    expect(s.snapshots).toHaveLength(5);
    expect(s.snapshots[4].actors.user.name).toBe("Replayed"); // the turn was played on the replayed state
    expect(s.audit!.some((a) => a.kind === "replay" && a.detail.includes("turn 2 of the conversation"))).toBe(true);
    expect(s.prints).toHaveLength(4);
  });
});

describe("the record is gone but the conversation is not", () => {
  it("it is rebuilt from the last turns (replay_turns), flagged approximate, and the narrator is told", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north", "I open the door", "I step through"]) await c.send(t);
    sessions.clear(); // a new container without the saved files
    const before = ollama.calls("extractor").length;
    ollama.s.extractor.push([{ op: "set", path: "actors.user.name", value: "Rebuilt" }]);
    const res = await c.send("What now?");
    expect(res.status).toBe(200);
    const s = sessions.get(KEY)!;
    const calls = (ollama.calls("extractor") as any[]).slice(before, before + 3).map((x) => x.body.messages.at(-1).content as string);
    expect(calls[0]).toContain("I go north"); // turns 2 and 3 (replay_turns 3 means turns 2..4: batch of 2, then 1)
    expect(calls[0]).toContain("I open the door");
    expect(calls[1]).toContain("I step through");
    expect(s.approximate).toBe(true);
    expect(narrator()).toContain("rebuilt from the conversation (3 recent turn(s) replayed, 1 earlier not)");
    expect(narrator()).not.toContain("The saved record for this chat was lost, so it starts again");
    expect(s.audit!.some((a) => a.kind === "rebuild")).toBe(true);
    expect(s.snapshots).toHaveLength(6);
  });
});

describe("when the record cannot be rebuilt", () => {
  it("the first attempts play on with a note; the third in a row is refused with a clear message, and it recovers when the extractor is back", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north", "I open the door"]) await c.send(t);
    ollama.s.extractorDown = true;
    c.log[0].content = "Let's play (edit 1)";
    let res = await c.send("a");
    expect(res.body.choices[0].message.content).toContain("torch flickers"); // played on
    expect(narrator()).toContain("behind the story");
    c.log[0].content = "Let's play (edit 2)";
    res = await c.send("b");
    expect(res.status).toBe(200);
    c.log[0].content = "Let's play (edit 3)";
    res = await c.send("c");
    expect(res.body.choices[0].message.content).toBe(REFUSAL);
    expect(sessions.get(KEY)!.abandoned).toBeDefined();
    const narratorCalls = ollama.calls("narrator").length;
    c.log.pop(); // the refused message was never answered
    ollama.s.extractorDown = false;
    c.log[0].content = "Let's play (edit 4)";
    res = await c.send("d");
    expect(res.body.choices[0].message.content).toContain("torch flickers");
    expect(ollama.calls("narrator").length).toBe(narratorCalls + 1);
    expect(sessions.get(KEY)!.abandoned).toBeUndefined();
    expect(sessions.get(KEY)!.audit!.map((a) => a.kind)).toEqual(expect.arrayContaining(["replay-failed", "refused", "replay"]));
  });
});

describe("saved with the session", () => {
  it("fingerprints and the audit log are in the saved file and come back after a restart", async () => {
    const { loadSessions } = await import("../src/utils/sessions.js");
    const c = chat();
    for (const t of ["Let's play", "I go north"]) await c.send(t);
    const kinds = sessions.get(KEY)!.audit!.map((a) => a.kind);
    sessions.clear(); loadSessions();
    const s = sessions.get(KEY)!;
    expect(s.prints).toHaveLength(2);
    expect(s.audit!.map((a) => a.kind)).toEqual(kinds);
    await c.send("I go on");
    expect(ollama.calls("extractor").length).toBe(3); // in step after a restart: no replay
    expect(extractorUsers()).toHaveLength(3);
  });
});
