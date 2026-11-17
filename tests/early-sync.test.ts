import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/early"); // early_sync: true
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset();
  sessions.clear();
  for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
const send = (id: string, text: string) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content: text }] });
const rename = (n: string) => [{ op: "set", path: "actors.user.name", value: n }];

describe("early_sync", () => {
  it("records the player's message before the narrator's reply is read, then the narration on top", async () => {
    ollama.s.extractor.push(rename("Joey"), [{ op: "push", path: "actors.user.statuses", value: "wet" }]);
    await send("e1", "I'm Joey");
    await sessions.get("chat:e1")!.tail;
    const ex = ollama.calls("extractor");
    expect(ex).toHaveLength(2);
    expect(ex[0].body.messages[0].content).toContain("EARLY PASS");
    expect(ex[1].body.messages[0].content).toContain("already read once");
    expect(ex[1].body.messages[1].content).toContain('"name":"Joey"'); // second pass starts from the early state
    const st = sessions.get("chat:e1")!.snapshots.at(-1)!;
    expect(st.actors.user.name).toBe("Joey");
    expect(st.actors.user.statuses).toEqual(["wet"]);
  });

  it("is already in the record when the reply ends (no wait for the bookkeeping)", async () => {
    ollama.s.extractor.push(rename("Joey"));
    await send("e2", "I'm Joey"); // resolves when the response ends
    expect(sessions.get("chat:e2")!.snapshots.at(-1)!.actors.user.name).toBe("Joey");
    await sessions.get("chat:e2")!.tail;
  });

  it("a failing early pass falls back to the normal sync", async () => {
    ollama.s.extractor.push("not json", "not json", "not json", rename("Joey"));
    await send("e3", "I'm Joey");
    await sessions.get("chat:e3")!.tail;
    expect(sessions.get("chat:e3")!.snapshots.at(-1)!.actors.user.name).toBe("Joey");
    expect(sessions.get("chat:e3")!.unsynced).toEqual([]);
  });
});
