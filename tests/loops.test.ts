import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/loops");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const say = async (id: string, history: string[], ops: unknown[] = []) => {
  const messages = history.flatMap((t, i) => (i === 0 ? [{ role: "user", content: t }] : [{ role: "assistant", content: "ok" }, { role: "user", content: t }]));
  ollama.s.narration = "ok"; ollama.s.extractor.push(ops);
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
  return { r, snap: sessions.get("chat:" + id)!.snapshots.at(-1)! };
};

describe("phase actions, silent phases, interrupts and the off-phase hush", () => {
  it("hushes a message that fits no action: no narrator, nothing changes", async () => {
    ollama.s.gates.push({ action: "none" });
    const { r, snap } = await say("l1", ["hello", "what's for lunch?"]);
    expect(r.body.choices[0].message.content).toBe("Hush, you.");
    expect(ollama.calls("narrator")).toHaveLength(0);
    expect(snap.game.phase).toBe("explore");
  });
  it("never hushes the first message, the one that starts the game", async () => {
    ollama.s.gates.push({ action: "none" });
    const { r } = await say("l1b", ["what's for lunch?"]);
    expect(r.body.choices[0].message.content).not.toBe("Hush, you.");
  });
  it("lets only the paths an action allows change", async () => {
    const { snap } = await say("l2", ["I walk to the cellar"], [{ op: "set", path: "actors.user.room", value: "cellar" }, { op: "set", path: "actors.user.hp", value: 99 }]);
    expect(snap.actors.user.room).toBe("cellar");
    expect(snap.actors.user.hp).toBeUndefined();
  });
  it("runs a silent phase on in the same turn", async () => {
    await say("l3", ["a goblin!"], [{ op: "set", path: "game.enemy_hp", value: 3 }, { op: "set", path: "game.phase", value: "combat" }]);
    expect(sessions.get("chat:l3")!.snapshots.at(-1)!.game.phase).toBe("combat");
    const { snap } = await say("l3", ["a goblin!", "I stab it"], [{ op: "set", path: "game.enemy_hp", value: 0 }]);
    expect(snap.game.phase).toBe("explore"); // combat > after (silent) > explore, in one turn
  });
  it("enters an interrupt phase from anywhere and returns to the phase it interrupted", async () => {
    const a = await say("l4", ["a spell!"], [{ op: "set", path: "game.phase", value: "magic" }]);
    expect(a.snap.game.phase).toBe("magic");
    expect(a.snap.game.resume).toBe("explore");
    const b = await say("l4", ["a spell!", "I finish it"], [{ op: "set", path: "game.spell_done", value: 1 }]);
    expect(b.snap.game.phase).toBe("explore");
    expect(b.snap.game.resume).toBeUndefined();
  });
});
