import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/wrap-exit"); // wrap_up.on_exit: "user"
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "warn").mockImplementation(() => {}); });

const u = (c: string) => ({ role: "user", content: c });
const a = (c: string) => ({ role: "assistant", content: c });
const send = async (id: string, messages: object[]) => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
  return r;
};

describe("the game ends when the player is out", () => {
  it("makes the next reply the finale, then answers with the fixed text and no model call", async () => {
    await send("x1", [u("one")]);
    expect(ollama.calls("narrator").at(-1)!.body.messages.at(-1).content).not.toContain("END THE SHOW NOW.");
    ollama.s.extractor.push([{ op: "inc", path: "actors.user.warmth", value: -10 }]);
    await send("x1", [u("one"), a("x"), u("brr")]); // this reply still plays; afterwards the player is out
    expect(sessions.get("chat:x1")!.snapshots.at(-1)!.game.exited_game.map((e) => e.id)).toEqual(["user"]);
    await send("x1", [u("one"), a("x"), u("brr"), a("y"), u("more")]);
    const finale = ollama.calls("narrator").at(-1)!.body.messages.at(-1).content as string;
    expect(finale).toContain("END THE SHOW NOW.");
    expect(sessions.get("chat:x1")!.wrapUp).toBe(3);
    const calls = ollama.calls("narrator").length;
    const over = await send("x1", [u("one"), a("x"), u("brr"), a("y"), u("more"), a("z"), u("again")]);
    expect(over.body.choices[0].message.content).toBe("The show is over.");
    expect(ollama.calls("narrator")).toHaveLength(calls);
  });
});
