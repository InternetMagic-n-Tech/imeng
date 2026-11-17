import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/goals-all");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

type Msg = { role: string; content: string };
const say = async (id: string, messages: Msg[], narration = "The Host grins.") => {
  ollama.s.narration = narration;
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)?.tail;
  return JSON.parse(r.text).choices[0].message.content as string;
};
const m = (...lines: string[]): Msg[] => lines.flatMap((l, i) => (i < lines.length - 1 ? [{ role: "user", content: l }, { role: "assistant", content: "x" }] : [{ role: "user", content: l }]));
const prompt = (): string => JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);

describe("goals: host all, standings always, reveal never, own texts", () => {
  it("tells the narrator everyone's goals, uses the game's words, and shows standings in /goals", async () => {
    await say("a1", m("hello"));
    expect(await say("a1", m("hello", "/goal be the funniest"))).toBe("Kept: be the funniest");
    await say("a1", m("hello", "again"));
    expect(prompt()).toContain("Bea secretly wants: be the funniest");
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "the funniest person" }] });
    await say("a1", m("hello", "again", "more"), "Bea is the funniest person here.");
    await say("a1", m("hello", "again", "more", "next"));
    expect(prompt()).toContain("Bea beams.");
    const list = await say("a1", m("hello", "again", "more", "next", "/goals"));
    expect(list).toContain("be the funniest (done)");
    expect(list).toContain("Goals done:");
    expect(list).toContain("Most goals: Bea.");
  });
  it("shows the counters to the narrator (only a blind host hides them)", async () => {
    await say("a2", m("hello"));
    expect(prompt()).toContain("goals_set");
  });
});
