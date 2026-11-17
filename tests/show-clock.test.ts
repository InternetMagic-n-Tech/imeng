import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/clock");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const turn = async (texts: string[]) => {
  const messages = texts.flatMap((t, i) => (i === 0 ? [{ role: "user", content: t }] : [{ role: "assistant", content: "ok" }, { role: "user", content: t }]));
  ollama.s.narration = "ok"; ollama.s.extractor.push([]);
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "c1").send({ messages });
  await sessions.get("chat:c1")!.tail;
  return { r, snap: sessions.get("chat:c1")!.snapshots.at(-1)!, prompt: JSON.stringify(ollama.calls("narrator").at(-1)?.body.messages ?? "") };
};

describe("the show clock", () => {
  it("charges fixed minutes per round, warns, makes the next reply the finale, then ends the show", async () => {
    const t: string[] = [];
    const go = async (m: string) => { t.push(m); return turn([...t]); };
    expect((await go("a")).snap.game.show_minutes).toBe(2); // phase "playing" has no cost entry: per_round 2
    const b = await go("b");
    expect(b.snap.game.show_minutes).toBe(4);
    expect(b.prompt).not.toContain("WRAP UP"); // 2 minutes in: before the warn mark
    const c = await go("c");
    expect(c.snap.game.show_minutes).toBe(6);
    expect(c.prompt).toContain("WRAP UP SOON"); // 4 minutes in: past the mark at 3
    const d = await go("d");
    expect(d.prompt).toContain("WRAP UP (this is the final turn)"); // 6 of 5: this reply is the finale
    const e = await go("e");
    expect(e.r.body.choices[0].message.content).toContain("The show is over!");
  });
});
