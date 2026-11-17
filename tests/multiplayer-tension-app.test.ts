import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/multiplayer-tension"); // tension.mode beats, private.reply narrator

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { tensionBeat } = await import("../src/utils/table.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");

const ollama = makeOllama();
type Who = { id: string; name: string };
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", PRIV = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
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
const narrators = () => ollama.calls("narrator");
const startTable = async () => {
  const t = chat(TABLE);
  await t.send(bea, "Let's play"); await settle();
  await t.send(bo, "I watch"); // Bo's first line makes it a table
  ollama.s.narration = "The torch flickers."; ollama.calls("narrator").length = 0;
  return t;
};

beforeEach(() => {
  ollama.reset();
  ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("tension.mode beats: the narrator keeps the waiting player's action in suspension", () => {
  it("each message while the table waits gets one short narrator line, built from what is declared and what was just said; the line is capped to max_words", async () => {
    const t = await startTable();
    ollama.s.narration = "Wolverine coils like a spring about to leap into the air, claws gleaming in the torchlight, everyone holding their breath";
    const first = await t.send(bea, "Wolverine leaps at the villain");
    expect(reply(first)).toBe("Wolverine coils like a spring about to leap into the air, claws"); // the first 12 words
    const call = narrators().at(-1)!.body;
    expect(call.stream).toBe(false);
    expect(call.messages[0].content).toContain("## TENSION BEAT");
    expect(call.messages[0].content).toContain("at most 12 words");
    expect(call.messages[0].content).toContain("Never resolve an outcome");
    expect(call.messages[1].content).toContain("Bea: Wolverine leaps at the villain");
    expect(call.messages[1].content).toContain("JUST SAID: Bea: Wolverine leaps at the villain");
    expect(call.messages[1].content).toContain("SCENE (last narration): The torch flickers.");
    expect(call.temperature).toBe(0.8);

    ollama.s.narration = "Wolverine sails through the air.";
    const second = await t.send(bo, "I shout: look out!");
    expect(reply(second)).toBe("Wolverine sails through the air.");
    const next = narrators().at(-1)!.body.messages;
    expect(next[0].content).toContain('Do not repeat the previous beat; move on from it: "Wolverine coils like a spring about to leap into the air, claws".');
    expect(next[1].content).toContain("Bo: I shout: look out!");
    await settle();
    expect(sessions.get(KEY)!.room!.beat!.text).toBe("Wolverine sails through the air.");
  });

  it("a beat is for the table only: it is not part of the story the next round is narrated from, and the round resolves it", async () => {
    const t = await startTable();
    ollama.s.narration = "Wolverine coils.";
    await t.send(bea, "Wolverine leaps at the villain");
    await t.send(bea, "ready");
    ollama.s.narration = "Wolverine lands a hit.";
    const done = await t.send(bo, "ready");
    expect(reply(done)).toBe("Wolverine lands a hit.");
    await settle();
    const round = narrators().at(-1)!.body;
    expect(round.messages[0].content).not.toContain("TENSION BEAT");
    expect(JSON.stringify(round.messages)).not.toContain("coils");
    expect(sessions.get(KEY)!.room!.beat).toBeUndefined();
  });

  it("when the narrator gives nothing or fails, the terse status is used instead (never an error)", async () => {
    const t = await startTable();
    ollama.s.narration = "   ";
    expect(reply(await t.send(bea, "I wait"))).toBe("Waiting for: Bea, Bo.");
    ollama.s.narratorThrows = true;
    const res = await t.send(bea, "I still wait");
    expect(res.status).toBe(200);
    expect(reply(res)).toBe("Waiting for: Bea, Bo.");
  });

  it("cooldown_seconds spaces beats out; in between the terse status is used", async () => {
    const room = newRoom();
    const cfg = { ...MULTIPLAYER!, tension: { ...MULTIPLAYER!.tension, cooldownMs: 60_000 } };
    join(room, { userId: "u-bea", name: "Bea" }, cfg, 0);
    const hold = { waiting: ["Bea"], declared: [{ who: "Bea", text: "leaps" }], scene: "A rooftop." };
    ollama.s.narration = "She coils.";
    expect(await tensionBeat(room, cfg, hold, 1_000)).toBe("She coils.");
    expect(await tensionBeat(room, cfg, hold, 30_000)).toBeNull();
    expect(await tensionBeat(room, cfg, hold, 62_000)).toBe("She coils.");
    expect(await tensionBeat(room, { ...cfg, tension: { ...cfg.tension, mode: "status" } }, hold, 999_999)).toBeNull();
    expect(await tensionBeat(room, cfg, undefined, 999_999)).toBeNull();
    expect(await tensionBeat(room, cfg, { waiting: ["Bea"], declared: [], scene: "" }, 999_999)).toBeNull(); // nothing to hold
  });
});

describe("private.reply narrator: a short private answer in the player's own chat", () => {
  it("the narrator answers the note privately, briefly, and the note still goes to the next round", async () => {
    const t = await startTable();
    const long = "The DM nods slowly, weighing it quietly, and says nothing to the table at all about it, ever, really, truly, absolutely, whatsoever";
    ollama.s.narration = long;
    const res = await chat(PRIV).send(bo, "I slip poison in Bea's cup");
    expect(reply(res)).toBe(long.split(" ").slice(0, 20).join(" ")); // the first 20 words
    const call = narrators().at(-1)!.body;
    expect(call.stream).toBe(false);
    expect(call.messages[0].content).toContain("## PRIVATE NOTE");
    expect(call.messages[0].content).toContain("Bo is passing you a private note");
    expect(call.messages[0].content).toContain("at most 20 words");
    expect(call.messages[0].content).toContain("CURRENT GAME STATE");
    expect(call.messages[1]).toEqual({ role: "user", content: "I slip poison in Bea's cup" });
    expect(sessions.get(KEY)!.room!.notes).toEqual([{ userId: "u-bo", text: "I slip poison in Bea's cup" }]);
    // nothing leaked to the table: the table's next message does not see it
    ollama.s.narration = "Wolverine coils.";
    expect(reply(await t.send(bea, "I raise my cup"))).not.toContain("poison");
  });

  it("when the narrator fails or says nothing, the player gets the fixed acknowledgement", async () => {
    await startTable();
    ollama.s.narration = "";
    expect(reply(await chat(PRIV).send(bo, "a note"))).toBe("Noted: the DM will weigh it in the next round. Only you can see this.");
    ollama.s.narratorThrows = true;
    const res = await chat("cccccccc-3333-4333-8333-cccccccccccc").send(bo, "another note");
    expect(res.status).toBe(200);
    expect(reply(res)).toBe("Noted: the DM will weigh it in the next round. Only you can see this.");
  });
});
