import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "imengs/backrooms");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); ollama.s.narration = "The hum fills the room."; for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const turns = async (id: string, texts: string[], ops: unknown[][]) => {
  const log: { role: string; content: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    log.push({ role: "user", content: texts[i] });
    ollama.s.extractor.push(ops[i] ?? []);
    const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: log });
    log.push({ role: "assistant", content: r.body.choices[0].message.content });
    await sessions.get("chat:" + id)!.tail;
  }
  return sessions.get("chat:" + id)!.snapshots.at(-1)!;
};

describe("imengs/backrooms: the monster rules in code", () => {
  it("starts with the tall, thin, lanky default and a monster actor to draw", async () => {
    const s = await turns("b1", ["Imeng: Backrooms"], [[]]);
    expect(s.actors.user.monster_size).toBe("taller");
    expect(String(s.actors.monster.description)).toMatch(/tall, thin, lanky/);
  });
  it("records a described monster; an invalid size is refused; distance moves at most 2 a turn", async () => {
    const s = await turns("b2", ["Imeng: Backrooms", "I'm Sam. Mine is a small crawling girl, like The Grudge."], [[], [
      { op: "set", path: "actors.user.monster", value: "a small girl crawling, long black hair" },
      { op: "set", path: "actors.user.monster_size", value: "tiny" },
      { op: "set", path: "actors.user.monster_distance", value: 0 },
    ]]);
    expect(s.actors.user.monster).toBe("a small girl crawling, long black hair");
    expect(s.actors.user.monster_size).toBe("taller");
    expect(s.actors.user.monster_distance).toBe(3);
  });
  it("ends the game with the credits when the monster catches the player", async () => {
    const log: { role: string; content: string }[] = [];
    const say = async (text: string, ops: unknown[]) => {
      log.push({ role: "user", content: text }); ollama.s.extractor.push(ops);
      const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "b3").send({ messages: log });
      log.push({ role: "assistant", content: r.body.choices[0].message.content });
      await sessions.get("chat:b3")!.tail;
      return r.body.choices[0].message.content as string;
    };
    await say("Imeng: Backrooms", []);
    await say("I run", [{ op: "inc", path: "actors.user.monster_distance", value: -2 }]);
    await say("I run", [{ op: "inc", path: "actors.user.monster_distance", value: -2 }]);
    const last = await say("I trip", [{ op: "inc", path: "actors.user.monster_distance", value: -2 }]);
    const st = sessions.get("chat:b3")!.snapshots.at(-1)!;
    expect(st.actors.user.monster_distance).toBe(0);
    expect(st.game.exited_game.map((e) => e.reason)).toContain("caught by the monster");
    void last;
    expect(await say("Is it over?", [])).toMatch(/Credits[\s\S]*Escape the Backrooms[\s\S]*Fancy Games and Blackbird Interactive[\s\S]*Secret Mode/); // the finale closes with the credits file
    expect(await say("hello?", [])).toBe("The hum has stopped. Start a new chat to step into the rooms again.");
  });
});
