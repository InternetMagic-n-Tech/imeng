import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/private-input");
const { splitPrivate, foldPrivate, PRIVATE_LINE } = await import("../src/utils/private-input.js");
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

const u = (content: string) => ({ role: "user", content }), a = (content: string) => ({ role: "assistant", content });

describe("splitPrivate and foldPrivate", () => {
  it("separates the public text from the private parts", () => {
    expect(splitPrivate("I act <private>my tattoo hurts</private> now")).toEqual({ pub: "I act  now", priv: ["my tattoo hurts"] });
    expect(splitPrivate("<PRIVATE>x</private>")).toEqual({ pub: "", priv: ["x"] });
    expect(splitPrivate("an open <private> tag").priv).toEqual([]);
  });
  it("a private-only message and the reply after it leave the conversation; its text goes to the next real message", () => {
    const f = foldPrivate([u("hello"), a("hi"), u("<private>my secret</private>"), a("The Host makes notes."), u("I go on")], true);
    expect(f.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(f.messages[2].content).toBe(`I go on\n\n${PRIVATE_LINE} my secret`);
    expect(f.latestOnly).toBe(false);
  });
  it("a latest private-only message is a note, not a round", () => {
    const f = foldPrivate([u("hello"), a("hi"), u("<private>note</private>")], true);
    expect(f.latestOnly).toBe(true);
    expect(f.latest).toEqual(["note"]);
    expect(f.messages).toHaveLength(2);
  });
  it("a mixed message keeps its public text and carries the private part (inline) or drops it (a table)", () => {
    const m = [u("I put my arm in the machine <private>I wince: the tattoo is not healed</private>")];
    expect(foldPrivate(m, true).messages[0].content).toBe(`I put my arm in the machine\n\n${PRIVATE_LINE} I wince: the tattoo is not healed`);
    const t = foldPrivate(m, false);
    expect(t.messages[0].content).toBe("I put my arm in the machine");
    expect(t.latest).toEqual(["I wince: the tattoo is not healed"]);
  });
  it("is deterministic: the same chat folds the same way every turn", () => {
    const m = [u("a <private>b</private> c"), a("x"), u("<private>d</private>"), a("ack"), u("e")];
    expect(JSON.stringify(foldPrivate(m, true))).toBe(JSON.stringify(foldPrivate(m, true)));
  });
});

const post = (id: string, messages: unknown[]) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });

describe("a solo game", () => {
  it("answers a private-only message with the placeholder, calls no model, and advances nothing", async () => {
    await post("i1", [u("hello")]); await sessions.get("chat:i1")!.tail;
    const turns = sessions.get("chat:i1")!.snapshots.length;
    ollama.s.calls.length = 0;
    const r = await post("i1", [u("hello"), a("The Host smiles."), u("<private>my secret</private>")]);
    expect(r.body.choices[0].message.content).toBe("The Host makes notes.");
    expect(ollama.s.calls).toHaveLength(0);
    expect(sessions.get("chat:i1")!.snapshots).toHaveLength(turns);
  });
  it("the next real message is turn 2, not 3, and the narrator gets the private text as a PRIVATE line", async () => {
    await post("i2", [u("hello")]); await sessions.get("chat:i2")!.tail;
    await post("i2", [u("hello"), a("The Host smiles."), u("<private>my secret</private>")]);
    const r = await post("i2", [u("hello"), a("The Host smiles."), u("<private>my secret</private>"), a("The Host makes notes."), u("I go on")]);
    expect(r.status).toBe(200);
    await sessions.get("chat:i2")!.tail;
    expect(sessions.get("chat:i2")!.snapshots).toHaveLength(3); // the start and two real turns
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).toContain("my secret");
  });
});
