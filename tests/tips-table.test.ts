import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-tips");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" };
const TABLE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("/tip at a table (through the app)", () => {
  it("answers at the table without a narrator call and moves one blind into the jar", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "I follow her in"); await settle();
    const calls = ollama.calls("narrator").length;
    const actor = sessions.get(KEY)!.room!.players[bea.id].actor;
    expect(await t.send(bea, "/tip")).toMatch(/tips the dealer 10\. The jar holds 10\./);
    const s = sessions.get(KEY)!.snapshots.at(-1)!;
    expect([(s.actors[actor] as any).chips, s.game.tips]).toEqual([90, 10]);
    expect(ollama.calls("narrator").length).toBe(calls);
  });
  it("after N hands with no tip the engine sets the cough and offers each seated person a tip privately", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "I follow her in"); await settle();
    sessions.get(KEY)!.snapshots.at(-1)!.game.hands_played = 2;
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    const s = sessions.get(KEY)!;
    expect(s.snapshots.at(-1)!.game.tip_notice === 1 || s.announcements!.some((e) => e.kind === "tip")).toBe(true);
    expect(s.announcements!.filter((e) => e.kind === "tip").map((e) => e.to).sort()).toEqual(["u-bea", "u-bo"]);
    expect(s.snapshots.at(-1)!.game.tip_mark).toBe(2);
  });
});
