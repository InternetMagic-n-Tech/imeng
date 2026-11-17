import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge"); // knowledge fixture: private chats on, covert transfer

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { KNOWLEDGE } = await import("../src/utils/config.js");
const J = await import("../src/utils/knowledge-judge.js");
const K = await import("../src/utils/knowledge.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");

const ollama = makeOllama();
type Who = { id: string; name: string };
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", PRIV = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", PRIV_BO = "cccccccc-3333-4333-8333-cccccccccccc";
const KEY = "chat:" + TABLE;
const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return { send: async (who: Who, text: string) => {
    log.push({ role: "user", content: text });
    const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", who.name).send({ messages: log });
    const content = res.body?.choices?.[0]?.message?.content;
    if (typeof content === "string") log.push({ role: "assistant", content });
    return res;
  } };
};
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };
const lastNarrator = (): string => JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
let table: ReturnType<typeof chat>;
const start = async () => {
  table = chat(TABLE);
  await table.send(bea, "Let's play"); await settle();
  await table.send(bo, "I watch"); await settle();
  ollama.s.calls.length = 0;
};
beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("<private> in a table's shared chat", () => {
  it("a private-only message is a note: no round, no narrator call, no turn; the note reaches the narrator on the next round", async () => {
    await start();
    const rounds = sessions.get(KEY)!.room!.rounds, snaps = sessions.get(KEY)!.snapshots.length;
    const r = await table.send(bea, "<private>I distrust the brother</private>");
    expect(reply(r)).toContain("Noted: the DM will weigh it");
    expect(ollama.calls("narrator")).toHaveLength(0);
    expect(sessions.get(KEY)!.room!.rounds).toBe(rounds);
    expect(sessions.get(KEY)!.snapshots).toHaveLength(snaps);
    await table.send(bea, "I ask the brother about the shop"); await settle();
    await table.send(bo, "I listen"); await settle();
    expect(lastNarrator()).toContain("PRIVATE, never reveal to the other players: I distrust the brother");
    expect(sessions.get(KEY)!.snapshots).toHaveLength(snaps + 2); // the two real messages are two rounds (free turns); the note was none
  });
  it("a message with public text and a private part is a round; the private part is a note for the narrator only", async () => {
    await start();
    await table.send(bea, "I put my arm in the machine <private>I wince: the tattoo is not healed</private>"); await settle();
    await table.send(bo, "I watch Bea"); await settle();
    const m = lastNarrator();
    expect(m).toContain("I put my arm in the machine");
    expect(m).toContain("PRIVATE, never reveal to the other players: I wince: the tattoo is not healed");
    expect(m).not.toContain("] I put my arm in the machine <private>");
  });
});

describe("the table sees that something passed, not what", () => {
  it("an NPC-to-NPC covert act reaches the narrator on the next round as a notice without its content", async () => {
    await start();
    ollama.s.covert.push({ covert: [{ from: "npc_brother", to: ["npc_rosa"], medium: "glance", about: "user", content: "Brother and Rosa agree to freeze Bea out." }] });
    await table.send(bea, "I wave"); await settle();
    await table.send(bo, "I nod"); await settle();
    await table.send(bea, "I wait"); await settle();
    await table.send(bo, "I wait too"); await settle();
    const m = lastNarrator();
    expect(m).toContain("Everyone at the table saw this happen (not what it was): Brother exchanges a look with Rosa");
    expect(m).not.toContain("freeze Bea out");
  });
});

describe("the leak guard respects <private>", () => {
  it("a watch-word inside a private block is not a leak; the same words in view still are", async () => {
    await start();
    await table.send(bea, "I wave at Bo"); await settle();
    ollama.s.calls.length = 0;
    ollama.s.narration = "The brother looks away. <private>He plans to sell the farm.</private>";
    await table.send(bea, "I ask the brother what he thinks"); await settle();
    expect(lastNarrator()).toContain("Known only to Brother: The brother plans to sell the farm.");
    expect(ollama.calls("narrator")).toHaveLength(1); // no rewrite
    expect(sessions.get(KEY)!.knowledge!.audit.map((a) => a.kind)).not.toContain("leak");
    ollama.s.narrations.push("The brother says he will sell the farm.", "The brother stares at his boots.");
    const r = await table.send(bea, "I ask the brother again");
    expect(reply(r)).toBe("The brother stares at his boots.");
    await settle();
    expect(sessions.get(KEY)!.knowledge!.audit.map((a) => a.kind)).toContain("leak");
  });
});

describe("private.unseated", () => {
  it("ignore (default): someone who is not at the table gets the placeholder and nothing is kept", async () => {
    await start();
    const cy: Who = { id: "u-cy", name: "Cy" };
    const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", TABLE).set("x-openwebui-user-id", cy.id).set("x-openwebui-user-name", cy.name)
      .send({ messages: [{ role: "user", content: "<private>I am new</private>" }] });
    expect(reply(r)).toBe("...");
    expect(sessions.get(KEY)!.room!.players[cy.id]).toBeUndefined();
    expect(sessions.get(KEY)!.room!.notes).toEqual([]);
  });
});
