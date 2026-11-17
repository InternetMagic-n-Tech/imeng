import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/wrap-tail"); // tail_notices + over_reply
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "warn").mockImplementation(() => {}); });

const filler = (n: number) => `message ${n} ` + "words ".repeat(60);
const chat = (n: number) => {
  const m: { role: string; content: string }[] = [];
  for (let i = 1; i <= n; i++) { m.push({ role: "user", content: filler(i) }); if (i < n) m.push({ role: "assistant", content: filler(100 + i) }); }
  return m;
};
const send = async (id: string, n: number, extra: object = {}) => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: chat(n), ...extra });
  await sessions.get("chat:" + id)!.tail;
  return r;
};
const lastBody = () => ollama.calls("narrator").at(-1)!.body;

describe("tail notices and the fixed game-over reply", () => {
  it("puts the wrap-up notice at the end of the last player message, not in the system prompt", async () => {
    await send("t1", 4);
    const msgs = lastBody().messages;
    expect(msgs[0].content).not.toContain("WRAP UP");
    const last = msgs.at(-1);
    expect(last.role).toBe("user");
    expect(last.content).toContain("WRAP UP (this is the final turn)");
    expect(last.content).toContain("CLOSE THE SHOW NOW.");
    expect(last.content).toContain("message 4 "); // the player's own words are still there
  });

  it("answers with the fixed text and no model call once the show is over (non-streaming)", async () => {
    await send("t2", 4);
    const before = ollama.calls("narrator").length;
    const r = await send("t2", 5);
    expect(r.body.choices[0].message.content).toBe("The show is over. Start a new chat to play again.");
    expect(ollama.calls("narrator")).toHaveLength(before);
    expect(ollama.calls("extractor").length).toBeGreaterThan(0); // from the earlier turns only
  });

  it("streams the fixed text when the client asks for a stream", async () => {
    await send("t3", 4);
    const r = await send("t3", 5, { stream: true });
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.text).toContain("The show is over.");
    expect(r.text).toContain("data: [DONE]");
  });

  it("puts state notes at the tail too", async () => {
    await send("t4", 1);
    ollama.s.extractor.push([{ op: "inc", path: "actors.user.warmth", value: -7 }]);
    await send("t4", 2);
    await send("t4", 3);
    const last = lastBody().messages.at(-1);
    expect(last.content).toContain("STATE NOTES");
    expect(lastBody().messages[0].content).not.toContain("STATE NOTES");
  });
});
