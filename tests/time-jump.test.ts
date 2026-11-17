import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/clockj");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const go = async (id: string, text: string) => {
  ollama.s.narration = "ok"; ollama.s.extractor.push([]);
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content: text }] });
  await sessions.get("chat:" + id)!.tail;
  return sessions.get("chat:" + id)!.snapshots.at(-1)!.game.show_minutes;
};

describe("time jumps on the show clock", () => {
  it("adds a story time jump on top of the fixed cost, capped at jump_max", async () => {
    ollama.s.jumps.push({ minutes: 50 });
    expect(await go("j1", "we all wait until sunrise")).toBe(2 + 3); // per_round 2, capped at 3
  });
  it("adds nothing for real-world talk or when the judge fails", async () => {
    ollama.s.jumps.push({ minutes: 0 });
    expect(await go("j2", "brb, ten minutes, my battery")).toBe(2);
    ollama.s.judgeDown = true;
    expect(await go("j3", "we wait until sunrise")).toBe(2);
  });
});
