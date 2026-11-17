import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/phases");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const send = async (id: string, messages: { role: string; content: string }[], ops: unknown[]) => {
  ollama.s.narration = "The Host nods."; ollama.s.extractor.push(ops);
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
  return { prompt: JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages), snap: sessions.get("chat:" + id)!.snapshots.at(-1)! };
};

describe("phases in a running game", () => {
  it("tells the narrator what is missing, refuses an early move, then lets it through", async () => {
    const a = await send("p1", [{ role: "user", content: "hi" }], [{ op: "set", path: "game.phase", value: "playing" }]);
    expect(a.prompt).toContain("GAME PHASE");
    expect(a.prompt).toContain("Ask every contestant for a goal.");
    expect(a.snap.game.phase).toBe("registration");
    const b = await send("p1", [{ role: "user", content: "hi" }, { role: "assistant", content: "The Host nods." }, { role: "user", content: "my goal is pink" }], [
      { op: "push", path: "actors.user.goals", value: { text: "pink", done: false } },
      { op: "push", path: "actors.npc_bo.goals", value: { text: "win", done: false } },
      { op: "set", path: "game.phase", value: "playing" },
    ]);
    expect(b.prompt).toContain("the game cannot move to playing yet");
    expect(b.snap.game.phase).toBe("playing");
    expect((b.snap.game.calc as any).goals_done).toEqual({ user: 0, npc_bo: 0 });
  });
});
