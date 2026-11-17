import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge"); // multiplayer free turns, knowledge on, one seeded NPC fact

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
type Who = { id: string; name: string };
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", PRIV = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", PRIV_BO = "cccccccc-3333-4333-8333-cccccccccccc";
const KEY = "chat:" + TABLE;

const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return {
    send: async (who: Who, text: string) => {
      log.push({ role: "user", content: text });
      const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", who.name).send({ messages: log });
      const content = res.body?.choices?.[0]?.message?.content;
      if (typeof content === "string") log.push({ role: "assistant", content });
      return res;
    },
  };
};
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };
const store = () => sessions.get(KEY)!.knowledge!;
const lastNarrator = (): string => JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
const allNarrators = (): string => JSON.stringify(ollama.calls("narrator").map((c) => c.body.messages));
const TATTOO = { kind: "fact", text: "Bea has a tattoo on her shoulder.", about: "user", known_by: [], access: "never", watch: ["tattoo"], discover: [{ kind: "action", when: "she shows her shoulder" }] };

let table: ReturnType<typeof chat>, priv: ReturnType<typeof chat>;
const startTable = async () => {
  table = chat(TABLE); priv = chat(PRIV);
  await table.send(bea, "Let's play"); await settle();
  await table.send(bo, "I watch"); await settle(); // Bo's first line makes it a table
  ollama.s.calls.length = 0;
};
const addTattoo = async () => { ollama.s.facts.push(TATTOO); await priv.send(bea, "I have a tattoo I hide"); return priv.send(bea, "yes"); };

beforeEach(() => {
  ollama.reset();
  ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("recording a fact in a private chat", () => {
  it("the judge structures it, the player confirms, and no model hears it: not the narrator, not the extractor", async () => {
    await startTable();
    ollama.s.facts.push(TATTOO);
    const proposed = reply(await priv.send(bea, "I have a tattoo on my shoulder that I hide"));
    expect(proposed).toContain("Reply yes to confirm");
    expect(sessions.get(KEY)!.room!.notes).toEqual([]); // not a note for the narrator
    expect(store().facts.filter((f) => f.createdBy === "u-bea")).toEqual([]); // nothing saved before the yes
    expect(reply(await priv.send(bea, "yes"))).toContain("Saved as f1");
    const f = store().facts.find((x) => x.id === "f1")!;
    expect(f).toMatchObject({ about: "user", access: "never", createdBy: "u-bea", knownBy: [] });
    await table.send(bea, "I ask the brother about the shop"); await settle();
    await table.send(bo, "I shrug"); await settle();
    expect(allNarrators()).not.toContain("tattoo");
    expect(JSON.stringify(ollama.calls("extractor").map((c) => c.body))).not.toContain("tattoo");
    expect(JSON.stringify(sessions.get(KEY)!.snapshots)).not.toContain("tattoo"); // never in a snapshot
  });

  it("no drops the proposal; an ordinary note still goes to the narrator; a repeat of yes saves nothing twice", async () => {
    await startTable();
    ollama.s.facts.push(TATTOO);
    await priv.send(bea, "I have a tattoo");
    expect(reply(await priv.send(bea, "no"))).toContain("Dropped");
    expect(store().facts.some((f) => f.createdBy === "u-bea")).toBe(false);
    expect(reply(await priv.send(bea, "I will check the door"))).toContain("Noted: the DM will weigh it");
    expect(sessions.get(KEY)!.room!.notes.map((n) => n.text)).toEqual(["I will check the door"]);
    expect(reply(await priv.send(bea, "yes"))).toContain("Noted"); // nothing pending: an ordinary message
  });

  it("fails closed: when the judge cannot be read the message is NOT passed to the narrator", async () => {
    await startTable();
    ollama.s.judgeDown = true;
    expect(reply(await priv.send(bea, "I have a tattoo"))).toContain("NOT passed on");
    expect(sessions.get(KEY)!.room!.notes).toEqual([]);
  });

  it("a person can only record what they know or what is about them; the sender is added as a knower", async () => {
    await startTable();
    ollama.s.facts.push({ kind: "fact", text: "Bo keeps a knife.", about: "p_bo", known_by: ["npc_brother"], access: "roleplaying", watch: ["knife"] });
    await priv.send(bea, "Bo keeps a knife, the brother saw it");
    await priv.send(bea, "yes");
    expect(store().facts.find((f) => f.id === "f1")!.knownBy).toEqual(["user", "npc_brother"]);
  });

  it("notes lists only your own facts; forget removes only yours; the audit has ids and turns, never the text", async () => {
    await startTable();
    await addTattoo();
    const patPriv = chat(PRIV_BO);
    expect(reply(await patPriv.send(bo, "notes"))).toBe("You have no facts recorded.");
    expect(reply(await patPriv.send(bo, "forget f1"))).toBe("No fact f1 of yours.");
    expect(reply(await priv.send(bea, "notes"))).toContain("f1: Bea has a tattoo on her shoulder.");
    expect(reply(await priv.send(bea, "forget f1"))).toBe("Forgot f1.");
    expect(store().facts.some((f) => f.id === "f1")).toBe(false);
    expect(store().audit.map((a) => a.kind)).toEqual(expect.arrayContaining(["proposed", "added", "viewed", "removed"]));
    expect(JSON.stringify(store().audit)).not.toContain("tattoo");
  });
});

describe("what the narrator holds, and when", () => {
  it("a roleplaying fact (seeded for the brother) is given only on a round where he speaks or is addressed", async () => {
    await startTable();
    await table.send(bea, "I wave at Bo"); await settle();
    expect(lastNarrator()).not.toContain("sell the farm");
    await table.send(bea, "I ask the brother what he thinks"); await settle();
    expect(lastNarrator()).toContain("Known only to Brother: The brother plans to sell the farm.");
    expect(lastNarrator()).toContain("## SECRET KNOWLEDGE");
  });

  it("a reply that states the fact is held back and rewritten once; the table never reads the first draft", async () => {
    await startTable();
    ollama.s.narrations.push("The brother says he will sell the farm.", "The brother stares at his boots.");
    const res = await table.send(bea, "I ask the brother what he thinks");
    expect(reply(res)).toBe("The brother stares at his boots.");
    const calls = ollama.calls("narrator");
    expect(calls[0].body.stream).toBe(false); // held, not streamed
    expect(JSON.stringify(calls[1].body.messages)).toContain("[server notice]");
    await settle();
    expect(store().audit.map((a) => a.kind)).toEqual(expect.arrayContaining(["leak", "leak-retried"]));
  });

  it("when the rewrite leaks too, the giving-away sentence is redacted", async () => {
    await startTable();
    ollama.s.narrations.push("He will sell the farm. He smiles.", "Again: sell the farm. He nods.");
    expect(reply(await table.send(bea, "I ask the brother"))).toBe("He nods.");
    await settle();
    expect(store().audit.map((a) => a.kind)).toContain("leak-redacted");
  });

  it("a reply that does not leak is delivered as written, with no second call", async () => {
    await startTable();
    ollama.s.narration = "The brother looks away.";
    expect(reply(await table.send(bea, "I ask the brother"))).toBe("The brother looks away.");
    expect(ollama.calls("narrator")).toHaveLength(1);
  });
});

describe("discovery", () => {
  it("an action trigger reveals the fact when the quote is really in the round; the narrator is told once, then it is known to the table", async () => {
    await startTable(); await addTattoo();
    ollama.s.triggers.push({ fired: [{ fact: "f1", trigger: 0, evidence: "she makes up words that never happened" }] });
    await table.send(bea, "I roll up my sleeve"); await settle();
    expect(store().facts[1].revealed).toBeUndefined(); // the quote is not in the round: refused by code
    ollama.s.triggers.push({ fired: [{ fact: "f1", trigger: 0, evidence: "I show my shoulder" }] });
    await table.send(bea, "I show my shoulder"); await settle();
    expect(store().facts.find((f) => f.id === "f1")!.revealed).toEqual({ turn: expect.any(Number), announced: false });
    await table.send(bo, "I look"); await settle();
    expect(lastNarrator()).toContain("## JUST REVEALED");
    expect(lastNarrator()).toContain("Bea has a tattoo on her shoulder.");
    await table.send(bo, "I look again"); await settle();
    expect(lastNarrator()).toContain("## KNOWN TO THE TABLE");
    expect(lastNarrator()).not.toContain("JUST REVEALED");
    expect(JSON.stringify(store().audit)).not.toContain("tattoo");
  });

  it("a statement waits for the person it is about to confirm in their own lines: someone else's yes does not count", async () => {
    await startTable();
    ollama.s.facts.push({ ...TATTOO, known_by: ["npc_brother"], access: "roleplaying", discover: [{ kind: "statement", by: "npc_brother", when: "the brother mentions it" }] });
    await priv.send(bea, "my brother saw me get a tattoo"); await priv.send(bea, "yes");
    ollama.s.narration = 'Brother grins: "ya like your dumb tattoo".';
    ollama.s.triggers.push({ fired: [{ fact: "f1", trigger: 0, evidence: "ya like your dumb tattoo" }] });
    await table.send(bea, "I ask the brother about the shop"); await settle();
    const f = () => store().facts.find((x) => x.id === "f1")!;
    expect(f().revealed).toBeUndefined();
    expect(f().candidate).toMatchObject({ trigger: 0 });
    ollama.s.narration = "The room waits.";
    ollama.s.triggers.push({ confirmed: [{ fact: "f1", trigger: 0, evidence: "yeah I do" }] });
    await table.send(bo, "yeah I do"); await settle();
    expect(f().revealed).toBeUndefined(); // Bo is not who it is about
    ollama.s.triggers.push({ confirmed: [{ fact: "f1", trigger: 0, evidence: "yeah I do" }] });
    await table.send(bea, "yeah I do"); await settle();
    expect(f().revealed).toBeDefined();
    expect(f().candidate).toBeUndefined();
  });

  it("a replayed turn hides again what came out on it", async () => {
    await startTable(); await addTattoo();
    ollama.s.triggers.push({ fired: [{ fact: "f1", trigger: 0, evidence: "I show my shoulder" }] });
    await table.send(bea, "I show my shoulder"); await settle();
    const k = store();
    const { rollbackKnowledge } = await import("../src/utils/knowledge.js");
    const { KNOWLEDGE } = await import("../src/utils/config.js");
    const turn = k.facts.find((f) => f.id === "f1")!.revealed!.turn;
    expect(rollbackKnowledge(k, KNOWLEDGE!, turn + 1)).toBe(0);
    expect(rollbackKnowledge(k, KNOWLEDGE!, turn)).toBe(1);
    expect(k.facts.find((f) => f.id === "f1")!.revealed).toBeUndefined();
  });
});
