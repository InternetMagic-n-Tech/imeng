import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/wrap-credits");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The hum fades.";
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const chat = (n: number) => {
  const m: { role: string; content: string }[] = [];
  for (let i = 1; i <= n; i++) { m.push({ role: "user", content: `move ${i}` }); if (i < n) m.push({ role: "assistant", content: `reply ${i}` }); }
  return m;
};
const send = async (id: string, n: number, stream = false) => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: chat(n), stream });
  await sessions.get("chat:" + id)!.tail;
  return r;
};

describe("wrap_up.credits_file", () => {
  it("adds the file word for word after the finale only, not to the narrator's record", async () => {
    for (let n = 1; n <= 3; n++) expect((await send("c1", n)).body.choices[0].message.content).toBe("The hum fades.");
    const r = await send("c1", 4);
    expect(r.body.choices[0].message.content).toBe("The hum fades.\n\n## Credits\nMade by Test & Co.");
    const last = ollama.calls("extractor").at(-1);
    expect(JSON.stringify(last?.body)).not.toContain("Made by Test");
  });
  it("also reaches a streamed reply", async () => {
    for (let n = 1; n <= 3; n++) await send("c2", n);
    const r = await send("c2", 4, true);
    expect(r.text).toContain("Made by Test & Co.");
    expect(r.text.indexOf("hum")).toBeLessThan(r.text.indexOf("Credits"));
  });
});
