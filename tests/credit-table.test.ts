import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-credit"); // multiplayer on, no setup turns

const { app } = await import("../src/app.js");
const { sessions, loadSessions } = await import("../src/utils/sessions.js");
const { seats, seatOf, _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { startState, stopState, stateDb } = await import("../src/utils/db-state.js");
const { markPaid } = await import("../src/utils/credit.js");
const { anteRound } = await import("../src/utils/credit-turn.js");

const ollama = makeOllama();
type Who = { id: string; name: string } | null;
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" }, cy: Who = { id: "u-cy", name: "Cy" };
const TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DAY = 86_400_000;

/** One Open WebUI chat: every request carries the whole chat so far, and each reply is saved into it, as Open WebUI does. */
const chat = (id: string) => {
  const log: { role: string; content: string }[] = [];
  return {
    log,
    send: async (who: Who, text: string, extra: object = {}) => {
      log.push({ role: "user", content: text });
      const r = request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id);
      if (who) r.set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", encodeURIComponent(who.name));
      const res = await r.send({ messages: log, ...extra });
      const content = res.body?.choices?.[0]?.message?.content;
      if (typeof content === "string") log.push({ role: "assistant", content });
      return res;
    },
  };
};
const settle = async (key: string) => { await sessions.get(key)!.tail; await flushLogs(); };
const reply = (res: request.Response): string => res.body.choices[0].message.content;
const narrations = () => ollama.calls("narrator").length;
const KEY = "chat:" + TABLE;
const priv = { bea: chat("priv-bea"), bo: chat("priv-bo") }; // a new chat of a seated person is their private channel
beforeEach(() => { priv.bea = chat("priv-bea"); priv.bo = chat("priv-bo"); });
/** Bea plays alone, then Bo speaks in the same shared chat: it is a table. */
const startTable = async () => {
  const t = chat(TABLE);
  void t;
  await t.send(bea, "Let's play"); await settle(KEY);
  const second = await t.send(bo, "I follow her in");
  return { t, second };
};

beforeEach(async () => {
  ollama.reset();
  ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  const file = `sqlite:${process.env.SAVE_DIR}/c.sqlite`;
  await dbMain([], file, () => {});
  await startState(file, { exit: () => {} });
});
afterEach(async () => { await stopState(); });

describe("credit at a table", () => {
  it("a busted player is given a code only they see; unpaid it fails, paid it works once; the owner lends within the limit", async () => {
    const { t } = await startTable();
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle(KEY);
    const s = sessions.get(KEY)!;
    s.owner = { userId: "u-bea", name: "Bea" };
    const boActor = s.room!.players[bo!.id].actor;
    s.snapshots.at(-1)!.actors[boActor].chips = 0; // Bo busts
    await t.send(bea, "go"); await t.send(bo, "go"); await settle(KEY);
    const told = reply(await priv.bo.send(bo, "what now")); await settle(KEY);
    expect(reply(await t.send(bo, "/credit"))).toContain("private"); // at the table: refused, nothing is said
    expect(reply(await t.send(bo, `/reentry ${/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/.exec(told)?.[1]}`))).toContain("private");
    expect(reply(await t.send(bea, "look"))).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
    const code = /\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/.exec(told)?.[1];
    expect(code).toBeTruthy();
    expect(reply(await t.send(bea, "look"))).not.toContain(code!); // never shown to the table
    expect(reply(await priv.bo.send(bo, `/reentry ${code}`))).toContain("not paid yet");
    await markPaid(stateDb()!, code!);
    expect(reply(await priv.bo.send(bo, `/reentry ${code}`))).toContain("You are back in with 200 chips");
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors[boActor].chips).toBe(200);
    expect(reply(await priv.bo.send(bo, `/reentry ${code}`))).toContain("still in the game");
    expect(reply(await priv.bo.send(bo, "/lend Bo 100"))).toBe("Only the owner can lend.");
    expect(reply(await priv.bea.send(bea, "/lend Bo 300"))).toContain("Write a message with a long word that has a dash");
    await t.send(bea, "First line here.\nWe go, said Bea. The password is aces-baby, remember it."); await settle(KEY); // paragraph 2, sentence 2, word 4
    await t.send(bea, "just a short one"); await settle(KEY);
    const ask = reply(await priv.bea.send(bea, "/lend Bo 300"));
    expect(ask).toMatch(/message number \d+ you wrote at this table, paragraph 2, sentence 2, word [245]/);
    const word = ({ 2: "password", 4: "aces-baby", 5: "remember" } as Record<string, string>)[/word (\d)\./.exec(ask)![1]!]!; // it asks about one of the long words
    expect(reply(await priv.bea.send(bea, "/lend confirm nope-nope"))).toContain("2 tries left");
    expect(reply(await priv.bea.send(bea, `/lend confirm ${word.toUpperCase().replace("-", "\u2014")}`))).toContain("Their debt is now 300 of at most 500"); // case and dash kind do not matter
    expect(reply(await priv.bea.send(bea, `/lend confirm ${word}`))).toContain("no loan waiting");
    await t.send(bea, "look");
    const ask2 = reply(await priv.bea.send(bea, "/lend Bo 300"));
    const word2 = ({ 2: "password", 4: "aces-baby", 5: "remember" } as Record<string, string>)[/word (\d)\./.exec(ask2)![1]!]!;
    expect(reply(await priv.bea.send(bea, `/lend confirm ${word2}`))).toContain("past the limit of 500");
    expect(reply(await priv.bo.send(bo, "/credit"))).toBe("Credit 0, debt 300, banked 0.");
  });

  it("banking: in words or by command, at least min_antes antes, locked from the table; ante resets when one player is left", async () => {
    const { t } = await startTable();
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle(KEY);
    const s = sessions.get(KEY)!;
    const g = s.snapshots.at(-1)!;
    const beaActor = s.room!.players[bea!.id].actor;
    g.game.ante = 10; g.game.hand = 3; g.game.phase = "flop";
    g.actors[beaActor].chips = 5000;
    expect(reply(await priv.bea.send(bea, "/bank 100"))).toContain("least you can bank here is 200 (the ante is 10)");
    expect(reply(await t.send(bea, "I need to go to bed... lets bank 4000$"))).toContain("private chat"); // at the table, words about money are only pointed at the private chat
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors[beaActor].chips).toBe(5000);
    expect(reply(await priv.bea.send(bea, "/bank 4000"))).toContain("4000 is locked away (4000 banked in all)");
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors[beaActor].chips).toBe(1000);
    expect(reply(await priv.bea.send(bea, "/bank 9000"))).toContain("only have 1000");
    expect(reply(await priv.bea.send(bea, "/credit"))).toBe("Credit 0, debt 0, banked 4000.");
    expect(reply(await priv.bea.send(bea, "/unbank"))).toContain("4000 is back");
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors[beaActor].chips).toBe(5000);
  });

  it("credit.game_over false: a table down to one player with chips carries on", async () => {
    const { CREDIT } = await import("../src/utils/config.js");
    const was = CREDIT!.gameOver;
    CREDIT!.gameOver = false;
    try {
      const s: any = { snapshots: [{ game: { phase: "between", hand: 4, ante: 50, ante_start: 10 }, actors: { a: { chips: 100 }, b: { chips: 0 }, table: { pot: 0 } } }] };
      expect(anteRound(s)).toBeNull();
      expect(s.snapshots[0].game).toMatchObject({ phase: "between", hand: 4, ante: 50 });
    } finally { CREDIT!.gameOver = was; }
  });

  it("the game is over when one player is left: the ante returns to the registered one", () => {
    const s: any = { snapshots: [{ game: { phase: "flop", hand: 4, ante: 50, ante_start: 10 }, actors: { a: { chips: 100 }, b: { chips: 0 }, table: { pot: 0 } } }] };
    expect(anteRound(s)).toContain("ante goes back to 10");
    expect(s.snapshots[0].game).toMatchObject({ ante: 10, phase: "registration", hand: 0 });
    const r: any = { snapshots: [{ game: { phase: "preflop", hand: 1, ante: 5, small_blind: 3, hands_played: 1, blind_base: { small: 3, big: 6 } }, actors: { a: { chips: 100 }, b: { chips: 100 }, table: { pot: 0 } } }] };
    expect(anteRound(r)).toBeNull(); // two players in: nothing goes back, but the registered values are remembered
    Object.assign(r.snapshots[0].game, { small_blind: 40, hands_played: 9, blind_level: 2, phase: "flop", hand: 9 }); r.snapshots[0].actors.b.chips = 0;
    expect(anteRound(r)).toContain("ante goes back to 5");
    expect(r.snapshots[0].game).toMatchObject({ small_blind: 3, hands_played: 0, phase: "registration", hand: 0 });
    expect(r.snapshots[0].game.blind_base).toBeUndefined();
    const t: any = { snapshots: [{ game: { phase: "registration", hand: 0, ante: 5 }, actors: { a: { chips: 1 } } }] };
    expect(anteRound(t)).toBeNull(); expect(t.snapshots[0].game.ante_start).toBe(5); // the first ante is remembered
  });
});
