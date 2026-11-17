import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/question");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const say = async (id: string, texts: string[], ops: unknown[] = []) => {
  const messages = texts.flatMap((t, i) => (i === 0 ? [{ role: "user", content: t }] : [{ role: "assistant", content: "ok" }, { role: "user", content: t }]));
  ollama.s.narration = "ok"; ollama.s.extractor.push(ops);
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
  return { r, snap: sessions.get("chat:" + id)!.snapshots.at(-1)! };
};

describe("the open question", () => {
  it("a message that is not from the one asked is not read, and a stuck question is dropped after two refusals", async () => {
    await say("q1", ["start"], [{ op: "set", path: "game.asked", value: "npc_bo" }]);
    const n = ollama.calls("narrator").length;
    const a = await say("q1", ["start", "my answer"]);
    expect(a.r.body.choices[0].message.content).toContain("not the one asked");
    expect(ollama.calls("narrator").length).toBe(n);
    const b = await say("q1", ["start", "my answer", "hello?"]);
    expect(b.r.body.choices[0].message.content).toContain("not the one asked");
    const c = await say("q1", ["start", "my answer", "hello?", "anyone?"]);
    expect(c.r.body.choices[0].message.content).toBe("ok"); // released: the table is never locked for good
    expect(ollama.calls("narrator").length).toBe(n + 1);
  });
  it("the one asked may answer", async () => {
    await say("q2", ["start"], [{ op: "set", path: "game.asked", value: "user" }]);
    const a = await say("q2", ["start", "my answer"]);
    expect(a.r.body.choices[0].message.content).toBe("ok");
  });
});
