import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/plain");
process.env.CONTEXT_MAX_ROUNDS = "3";
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const chat = (n: number) => {
  const m: { role: string; content: string }[] = [];
  for (let i = 1; i <= n; i++) {
    m.push({ role: "user", content: `turn ${i}` });
    if (i < n) m.push({ role: "assistant", content: `reply ${i}` });
  }
  return m;
};
const send = async (id: string, n: number) => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: chat(n) });
  if (r.status !== 200) throw new Error("status " + r.status + " " + r.text);
  await sessions.get("chat:" + id)!.tail;
  return ollama.calls("narrator").at(-1)!.body.messages[0].content as string;
};

describe("CONTEXT_MAX_ROUNDS (the machine guard, no wrap_up in the game)", () => {
  it("is quiet before the ceiling", async () => {
    expect(await send("r1", 2)).not.toContain("WRAP UP");
  });
  it("closes the game on the ceiling round with the built-in wording, then it is over", async () => {
    const final = await send("r2", 3);
    expect(final).toContain("WRAP UP (this is the final turn)");
    expect(final).toContain("bring the game to a natural, warm close");
    expect(sessions.get("chat:r2")!.wrapUp).toBe(3);
    expect(await send("r2", 4)).toContain("GAME OVER");
  });
});
