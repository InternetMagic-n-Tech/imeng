import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/wrap");
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

describe("wrap up (the escape hatch)", () => {
  it("stays out of the way while there is room", async () => {
    const sys = await send("w1", 2);
    expect(sys).not.toContain("WRAP UP");
    expect(sessions.get("chat:w1")!.wrapUp).toBeUndefined();
  });

  it("tells the narrator to close the game when the prompt is nearly full, then that it is over", async () => {
    const final = await send("w2", 4);
    expect(final).toContain("WRAP UP (this is the final turn)");
    expect(final).toContain("CLOSE THE SHOW NOW.");
    expect(sessions.get("chat:w2")!.wrapUp).toBe(4);
    const after = await send("w2", 5);
    expect(after).toContain("GAME OVER");
    expect(after).not.toContain("CLOSE THE SHOW NOW.");
  });

  it("keeps the same final turn when the player regenerates it", async () => {
    await send("w3", 4);
    const again = await send("w3", 4);
    expect(again).toContain("WRAP UP (this is the final turn)");
  });

  it("decides afresh when the player goes back before the final turn", async () => {
    await send("w4", 4);
    const back = await send("w4", 3);
    expect(back).not.toContain("WRAP UP");
    expect(back).not.toContain("GAME OVER");
    expect(sessions.get("chat:w4")!.wrapUp).toBeUndefined();
  });
});
