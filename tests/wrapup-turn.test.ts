import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/wrap-turn");
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

const filler = (n: number) => `message ${n} ` + "words ".repeat(60);
const chat = (n: number) => {
  const m: { role: string; content: string }[] = [];
  for (let i = 1; i <= n; i++) {
    m.push({ role: "user", content: filler(i) });
    if (i < n) m.push({ role: "assistant", content: filler(100 + i) });
  }
  return m;
};
const send = async (id: string, n: number) => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: chat(n) });
  if (r.status !== 200) throw new Error("status " + r.status + " " + r.text);
  await sessions.get("chat:" + id)!.tail;
  return ollama.calls("narrator").at(-1)!.body.messages[0].content as string;
};

describe("wrap up by turn budget (at_turn, soon_turns)", () => {
  it("is quiet before the heads-up window", async () => {
    const sys = await send("t1", 1);
    expect(sys).not.toContain("WRAP UP");
  });
  it("gives a heads-up for the soon_turns before the budget, without closing the game", async () => {
    const sys = await send("t2", 2);
    expect(sys).toContain("WRAP UP SOON (the game ends in 2 turn(s))");
    expect(sys).toContain("Do not announce the end yet.");
    expect(sessions.get("chat:t2")!.wrapUp).toBeUndefined();
    expect(await send("t2", 3)).toContain("ends in 1 turn(s)");
  });
  it("closes the game on the budget turn, then it is over", async () => {
    const final = await send("t3", 4);
    expect(final).toContain("WRAP UP (this is the final turn)");
    expect(final).not.toContain("WRAP UP SOON");
    expect(sessions.get("chat:t3")!.wrapUp).toBe(4);
    expect(await send("t3", 5)).toContain("GAME OVER");
  });
  it("decides afresh when the player goes back before the budget", async () => {
    await send("t4", 4);
    const back = await send("t4", 3);
    expect(back).toContain("WRAP UP SOON");
    expect(sessions.get("chat:t4")!.wrapUp).toBeUndefined();
  });
});

