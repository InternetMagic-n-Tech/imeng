import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { openDb } = await import("../src/utils/db.js");
const { migrateUp, readState, MIGRATION_NAMES } = await import("../src/utils/db-migrations.js");
const { StateGuard, judgeState } = await import("../src/utils/state-guard.js");
const { startState, stopState, stateDb, stateNow, expectedStamp } = await import("../src/utils/db-state.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { openDb: open2 } = await import("../src/utils/db.js");

const ollama = makeOllama();
const want = () => expectedStamp();
const migrated = async () => { const db = await openDb("sqlite::memory:"); await migrateUp(db, want()); return db; };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(async () => { await stopState(); jest.restoreAllMocks(); });

describe("migrations and the stamp", () => {
  it("an empty database is behind; migrating makes it match, and again does nothing", async () => {
    const db = await openDb("sqlite::memory:");
    expect(judgeState(await readState(db), want())).toMatchObject({ ok: false, reason: expect.stringContaining("pending") });
    expect(await migrateUp(db, want())).toEqual(MIGRATION_NAMES);
    expect(judgeState(await readState(db), want())).toEqual({ ok: true });
    expect(await migrateUp(db, want())).toEqual([]);
    await db.destroy();
  });

  it("a database migrated by a newer deployment is ahead", async () => {
    const db = await migrated();
    await db.insertInto("kysely_migration").values({ name: "999_future", timestamp: "now" }).execute();
    expect(judgeState(await readState(db), want())).toMatchObject({ ok: false, found: "999_future", reason: expect.stringContaining("ahead") });
    await db.destroy();
  });

  it.each(["rules", "game", "proxy"])("a different %s stamp is a failure", async (k) => {
    const db = await migrated();
    await db.updateTable("stamp").set({ value: "other" }).where("key", "=", k).execute();
    expect(judgeState(await readState(db), want())).toEqual({ ok: false, reason: `${k} version stamp differs`, expected: (want() as never)[k], found: "other" });
    await db.destroy();
  });
});

describe("StateGuard", () => {
  it("trips once on a bad stamp, stops the timer and exits 1", async () => {
    const db = await migrated();
    const exit = jest.fn();
    const g = new StateGuard({ db, expected: want(), intervalMs: 1000, exit, log: () => {} });
    expect((await g.check()).ok).toBe(true);
    await db.updateTable("stamp").set({ value: "x" }).where("key", "=", "proxy").execute();
    expect((await g.check()).ok).toBe(false);
    await g.check();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    await db.destroy();
  });

  it("with logOnly it logs and carries on, and recovers when the stamp is right again", async () => {
    const db = await migrated();
    const exit = jest.fn(), log = jest.fn();
    const g = new StateGuard({ db, expected: want(), intervalMs: 1000, exit, log, logOnly: true });
    await db.updateTable("stamp").set({ value: "x" }).where("key", "=", "rules").execute();
    expect((await g.check()).ok).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain("Carrying on");
    await db.updateTable("stamp").set({ value: want().rules }).where("key", "=", "rules").execute();
    expect((await g.check()).ok).toBe(true);
    await db.destroy();
  });

  it("an unreachable database is logged, not a version failure", async () => {
    const db = await migrated();
    const log = jest.fn(), exit = jest.fn();
    const g = new StateGuard({ db, expected: want(), intervalMs: 1000, exit, log });
    await db.destroy();
    expect((await g.check()).ok).toBe(true);
    expect(String(log.mock.calls[0][0])).toContain("could not read");
    expect(exit).not.toHaveBeenCalled();
  });

  it("the timer re-reads the stamp by itself", async () => {
    const db = await migrated();
    const exit = jest.fn();
    const g = new StateGuard({ db, expected: want(), intervalMs: 20, exit, log: () => {} });
    g.start();
    await db.updateTable("stamp").set({ value: "x" }).where("key", "=", "game").execute();
    await new Promise((r) => setTimeout(r, 120));
    expect(exit).toHaveBeenCalledWith(1);
    g.stop();
    await db.destroy();
  });
});

describe("a running instance", () => {
  it("is healthy with no database, and refuses to start on one that is not migrated", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect(await startState("")).toEqual({ ok: true });
    expect((await startState("sqlite::memory:", { exit: () => {} })).ok).toBe(false);
  });

  it("a stamp that goes bad stops the turns and turns /healthz to 503", async () => {
    const exit = jest.fn();
    const file = `sqlite:${process.env.SAVE_DIR}/live.sqlite`;
    await dbMain([], file, () => {});
    expect((await startState(file, { exit })).ok).toBe(true);
    expect((await stateNow()).ok).toBe(true);
    expect((await request(app).get("/healthz")).body).toEqual({ ok: true });
    const t = makeChat(app, "st");
    expect(await t.send({ id: "u-bea", name: "Bea" }, "Let's play")).toBe("The torch flickers.");
    await sessions.get("chat:st")!.tail; await flushLogs();
    await stateDb()!.insertInto("kysely_migration").values({ name: "999_future", timestamp: "now" }).execute();
    const calls = ollama.calls("narrator").length;
    expect(await t.send({ id: "u-bea", name: "Bea" }, "I look around")).toBe("This game is temporarily unavailable. Try again in a moment.");
    expect(ollama.calls("narrator").length).toBe(calls);
    const h = await request(app).get("/healthz");
    expect(h.status).toBe(503);
    expect(h.body).toMatchObject({ ok: false, found: "999_future" });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("db:migrate", () => {
  it("applies, then reports up to date; --status exits 1 when behind", async () => {
    const out: string[] = [];
    const file = `${process.env.SAVE_DIR}/db.sqlite`;
    expect(await dbMain(["--status"], `sqlite:${file}`, (m) => out.push(m))).toBe(1);
    expect(await dbMain([], `sqlite:${file}`, (m) => out.push(m))).toBe(0);
    expect(out.at(-1)).toBe("Applied: 001_players, 002_rehydrate_eligibility, 003_attachments, 004_bans_and_pii_tokens, 005_candidates, 006_credit, 007_hand_log, 008_code_terms, 009_terms");
    expect(await dbMain([], `sqlite:${file}`, (m) => out.push(m))).toBe(0);
    expect(out.at(-1)).toBe("Nothing to apply.");
    expect(await dbMain(["--status"], `sqlite:${file}`, (m) => out.push(m))).toBe(0);
    expect(out.at(-1)).toBe("Database is up to date.");
    expect(await dbMain([], "", (m) => out.push(m))).toBe(1);
  });

  it("a Postgres or SQLite url is required", async () => {
    await expect(open2("mysql://x")).rejects.toThrow("DATABASE_URL must start with");
  });
});
