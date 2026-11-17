import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-terms");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { TERMS } = await import("../src/utils/config.js");
const T = await import("../src/utils/terms.js");
const { openDb } = await import("../src/utils/db.js");
const { migrateUp } = await import("../src/utils/db-migrations.js");
const { expectedStamp, startState, stopState, stateDb } = await import("../src/utils/db-state.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" };
const TABLE = "ffffffff-6666-4666-8666-ffffffffffff", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)?.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The cards are out.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(async () => { await stopState(); });

describe("the game's terms", () => {
  it("is configured and read from the game folder", () => {
    expect(TERMS).toMatchObject({ file: "terms.md", rememberDays: 30, notice: "The terms are in your private messages." });
    expect(T.termsChunks()).toEqual(["# Terms\n\nWe keep your chat 30 days.\n\nNothing leaves this machine."]);
  });
  it("long terms are split at paragraph breaks into messages a DM can carry", () => {
    const para = "x".repeat(800), parts = T.termsChunks([para, para, para].join("\n\n"));
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.length <= 1900)).toBe(true);
    expect(T.termsChunks("y".repeat(4000))).toHaveLength(3); // one paragraph longer than a message is cut
    expect(T.termsChunks("")).toEqual([]);
  });
  it("is sent once per person without a database (the session remembers), never to an anonymous person", async () => {
    const s: any = { announcements: [] };
    expect(await T.sendTerms(s, { userId: "u1", name: "Bea" }, 1000)).toBe(true);
    expect(s.announcements.map((e: any) => [e.kind, e.to])).toEqual([["terms", "u1"]]);
    expect(await T.sendTerms(s, { userId: "u1", name: "Bea" }, 2000)).toBe(false);
    expect(await T.sendTerms(s, { userId: "u1", name: "Bea" }, 1000 + 31 * 86_400_000)).toBe(true); // remember_days 30 have passed
    expect(await T.sendTerms(s, { userId: "anonymous", name: "?" }, 1000)).toBe(false);
  });
  it("is remembered in the database per person and game when there is one", async () => {
    const db = await openDb("sqlite::memory:"); await migrateUp(db, expectedStamp()); await db.destroy();
    await startState("sqlite::memory:", { exit: () => {} });
    await migrateUp(stateDb()!, expectedStamp());
    const a: any = { announcements: [] }, b: any = { announcements: [] };
    expect(await T.sendTerms(a, { userId: "u1", name: "Bea" }, 1000)).toBe(true);
    expect(await T.sendTerms(b, { userId: "u1", name: "Bea" }, 2000)).toBe(false); // another session, same person: not again
    expect(await T.sendTerms(b, { userId: "u1", name: "Bea" }, 1000 + 31 * 86_400_000)).toBe(true);
  });
  it("a seat gets the terms privately, and the table sees only the notice", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "/seat 30 male");
    const seated = await t.send(bo, "/seat yes");
    expect(seated).toBe("Bo has a seat. The terms are in your private messages.");
    expect(seated).not.toMatch(/Nothing leaves/);
    const ev = (sessions.get(KEY)!.announcements ?? []).filter((e) => e.kind === "terms");
    expect(ev.map((e) => e.to)).toEqual(["u-bo"]);
    expect(ev[0].text).toContain("Nothing leaves this machine");
    await t.send(bo, "/seat 30 male"); // already seated: nothing more is sent
    expect((sessions.get(KEY)!.announcements ?? []).filter((e) => e.kind === "terms")).toHaveLength(1);
  });
});
