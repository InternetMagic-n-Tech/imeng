import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

// The default fixture has no `sync` key: mode detect (the default). Fingerprints and the audit log are kept; nothing is repaired.
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const KEY = "chat:detect-chat";
const chat = () => {
  const log: { role: string; content: string }[] = [];
  return { log, send: async (text: string) => { log.push({ role: "user", content: text }); const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "detect-chat").send({ messages: log }); log.push({ role: "assistant", content: r.body.choices[0].message.content }); await sessions.get(KEY)?.tail; await flushLogs(); return r; } };
};

beforeEach(() => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "asks to play" }; ollama.s.setup = { rules: [], actors: [] }; ollama.s.narration = "The torch flickers as you step into the long stone corridor and the cold draft finds you.";
  sessions.clear(); fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("sync.mode detect (the default)", () => {
  it("an edited earlier message is noticed and written to the audit log, but nothing is replayed", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north", "I open the door"]) await c.send(t);
    c.log[2].content = "I go SOUTH instead";
    await c.send("I look around");
    const s = sessions.get(KEY)!;
    expect(s.audit!.some((a) => a.kind === "detected" && a.detail.includes("nothing was repaired"))).toBe(true);
    expect(ollama.calls("extractor")).toHaveLength(4); // one per turn, no replay
    expect(s.approximate).toBeUndefined();
    expect(s.snapshots).toHaveLength(5);
  });

  it("a record that is gone starts again, with the old note (as before), and says so in the audit log", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north"]) await c.send(t);
    sessions.clear();
    await c.send("What now?");
    expect(ollama.calls("narrator").at(-1)!.body.messages.map((m: any) => m.content).join("\n")).toContain("The saved record for this chat was lost, so it starts again");
    expect(sessions.get(KEY)!.audit!.some((a) => a.kind === "detected")).toBe(true);
  });

  it("an old record without fingerprints is adopted, not doubted", async () => {
    const c = chat();
    for (const t of ["Let's play", "I go north"]) await c.send(t);
    delete sessions.get(KEY)!.prints; // as saved before this feature existed
    await c.send("I go on");
    expect(sessions.get(KEY)!.audit!.some((a) => a.kind === "adopt")).toBe(true);
    expect(sessions.get(KEY)!.prints).toHaveLength(3);
  });
});
