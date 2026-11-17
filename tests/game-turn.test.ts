import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/game-turn");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset();
  ollama.s.narration = "The Host beams.";
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const chat = (n: number) => {
  const m: { role: string; content: string }[] = [];
  for (let i = 1; i <= n; i++) {
    m.push({ role: "user", content: `answer ${i}` });
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
const gameOf = (id: string, round: number) => sessions.get("chat:" + id)!.snapshots[round].game as Record<string, any>;
const stain = (id: string, round: number, who: string, v: number) => { (sessions.get("chat:" + id)!.snapshots[round].actors[who] as any).stain = v; };

describe("game turns (judged advance)", () => {
  it("does not advance while the judge says no, and keeps what was said since the last game turn", async () => {
    await send("a", 1);
    expect(gameOf("a", 1).game_turn).toBe(0);
    await send("a", 2);
    expect(gameOf("a", 2).game_turn).toBe(0);
    expect(sessions.get("chat:a")!.turnLog!.map((e) => e.round)).toEqual([1, 2]);
    expect(ollama.calls("narrator").at(-1)!.body.messages[0].content).toContain("It is round 0 of the game.");
  });

  it("counts a game turn when the judge says so, resets the log and tells the narrator what fired", async () => {
    ollama.s.turnVerdicts.push({ advanced: true });
    await send("b", 1);
    expect(gameOf("b", 1).game_turn).toBe(1);
    expect(sessions.get("chat:b")!.turnLog).toEqual([]);
    const sys = await send("b", 2);
    expect(sys).toContain("It is round 1 of the game.");
    expect(sys).toContain("EVENT: A new round begins.");
    expect(await send("b", 3)).not.toContain("EVENT: A new round begins."); // told once
  });

  it("rolls the game turn back with the record when the player goes back", async () => {
    ollama.s.turnVerdicts.push({ advanced: true }, { advanced: true });
    await send("c", 1); await send("c", 2);
    expect(gameOf("c", 2).game_turn).toBe(2);
    ollama.s.turnVerdicts.push({ advanced: false });
    await send("c", 2); // regenerated
    expect(gameOf("c", 2).game_turn).toBe(1);
  });

  it("a tie at the top on the tenth... here the second game turn fires the tie event and sets the phase", async () => {
    ollama.s.turnVerdicts.push({ advanced: true }, { advanced: true });
    await send("d", 1);
    stain("d", 1, "user", 5); stain("d", 1, "npc_bo", 5);
    await send("d", 2);
    const g = gameOf("d", 2);
    expect(g.game_turn).toBe(2);
    expect(g.phase).toBe("sudden_death");
    expect(g.fired).toEqual(expect.arrayContaining(["tie", "tick@2"]));
    expect(g.fired).not.toContain("win");
    expect(sessions.get("chat:d")!.wrapUp).toBeUndefined();
    expect(await send("d", 3)).toContain("Tied at the top: one lightning round");
  });

  it("no tie: the win event ends the game on the next round with its own closing text, then it is over", async () => {
    ollama.s.turnVerdicts.push({ advanced: true }, { advanced: true });
    await send("e", 1);
    stain("e", 1, "user", 7); stain("e", 1, "npc_bo", 2);
    await send("e", 2);
    expect(sessions.get("chat:e")!.wrapUp).toBe(3);
    const final = await send("e", 3);
    expect(final).toContain("WRAP UP (this is the final turn)");
    expect(final).toContain("Crown the most stained contestant.");
    expect(await send("e", 4)).toContain("GAME OVER");
  });

  it("the sudden-death round (game turn 3) ends the game with its own text", async () => {
    ollama.s.turnVerdicts.push({ advanced: true }, { advanced: true }, { advanced: true });
    await send("f", 1);
    stain("f", 1, "user", 4); stain("f", 1, "npc_bo", 4);
    await send("f", 2); await send("f", 3);
    expect(gameOf("f", 3).game_turn).toBe(3);
    expect(await send("f", 4)).toContain("Name the winner of the lightning round.");
  });

  it("a judge that is down means no advance, never a failed turn", async () => {
    ollama.s.judgeDown = true;
    await send("g", 1);
    expect(gameOf("g", 1).game_turn).toBe(0);
  });

  it("the judge can release a timed effect, and an effect added by the extractor expires by itself", async () => {
    ollama.s.extractor.push({ ops: [{ op: "effect", who: "actors.user", text: "wears the hat backward", turns: 2 }] });
    ollama.s.turnVerdicts.push({ advanced: false });
    await send("h", 1);
    const e = (gameOf("h", 1).effects as any[])[0];
    expect(e).toMatchObject({ who: "user", text: "wears the hat backward", until: 2 });
    expect(await send("h", 2)).toContain("Bea: wears the hat backward (until round 2");
    ollama.s.turnVerdicts.push({ advanced: false, released: [e.id] });
    await send("h", 2);
    expect(gameOf("h", 2).effects).toEqual([]);
    ollama.s.extractor.push({ ops: [{ op: "effect", who: "actors.user", text: "sings", turns: 1 }] });
    ollama.s.turnVerdicts.push({ advanced: true });
    await send("h", 3);
    expect(gameOf("h", 3).effects).toEqual([]); // until 1... expired when the game turn became 1
  });
});
