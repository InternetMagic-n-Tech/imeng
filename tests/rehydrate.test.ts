import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";
import type { Who } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/rehydrate-table");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { startState, stopState, stateDb } = await import("../src/utils/db-state.js");
const { ELIGIBILITY } = await import("../src/utils/eligibility-config.js");
const { bit, maskOf, namesOf, joinCheck, joinRefusal, getMask, setFlag, applyRules } = await import("../src/utils/eligibility.js");
const { pull, push } = await import("../src/utils/rehydrate.js");
const { migrateUp } = await import("../src/utils/db-migrations.js");
const { expectedStamp } = await import("../src/utils/db-state.js");
const { openDb } = await import("../src/utils/db.js");

const ollama = makeOllama();
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const GAME = "rehydrate-table";
const settle = async (key: string) => { await sessions.get(key)!.tail; await flushLogs(); };
const cfg = ELIGIBILITY!;

beforeEach(async () => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  const file = `sqlite:${process.env.SAVE_DIR}/r.sqlite`;
  await dbMain([], file, () => {});
  await startState(file, { exit: () => {} });
});
afterEach(async () => { await stopState(); jest.restoreAllMocks(); });

const rows = () => stateDb()!.selectFrom("player_state").selectAll().orderBy("user_id").execute();

describe("eligibility flags", () => {
  it("compile to a bitmask by position, and joining needs every require flag and no block flag", () => {
    expect(bit(cfg, "opted_in")).toBe(1);
    expect(bit(cfg, "busted")).toBe(2);
    expect(maskOf(cfg, ["busted", "opted_in"])).toBe(3);
    expect(namesOf(cfg, 2)).toEqual(["busted"]);
    expect(joinCheck(cfg, 0)).toEqual({ ok: false, missing: ["opted_in"], blocked: [] });
    expect(joinCheck(cfg, 1).ok).toBe(true);
    expect(joinCheck(cfg, 3)).toMatchObject({ ok: false, blocked: ["busted"] });
    expect(joinRefusal(cfg, 3)).toBe("You can't join this game yet: busted stops you.");
    expect(joinRefusal(cfg, 1)).toBeNull();
  });

  it("are kept per person; a row of another version counts as empty, and db:migrate resets such rows", async () => {
    const db = stateDb()!;
    expect(await getMask(db, cfg, "u1", 1000)).toBe(0);
    expect(await setFlag(db, cfg, "u1", "opted_in", true, 1000)).toBe(1);
    expect(await setFlag(db, cfg, "u1", "busted", true, 1000)).toBe(3);
    expect(await setFlag(db, cfg, "u1", "busted", false, 1000)).toBe(1);
    await db.updateTable("eligibility").set({ version: 0 }).execute();
    expect(await getMask(db, cfg, "u1", 1000)).toBe(0);
    await migrateUp(db, expectedStamp());
    expect((await db.selectFrom("eligibility").selectAll().executeTakeFirst())).toMatchObject({ mask: 0, version: 1 });
    await db.updateTable("eligibility").set({ expires_at: 5 }).execute();
    expect(await getMask(db, cfg, "u1", 1000)).toBe(0); // expired
  });

  it("the game's rules set a flag while the condition holds", async () => {
    const db = stateDb()!;
    const state = { game: {}, actors: { user: { hp: 0 } } } as never;
    expect(await applyRules(db, cfg, "u1", "user", state, 1000)).toBe(2);
    (state as any).actors.user.hp = 4;
    expect(await applyRules(db, cfg, "u1", "user", state, 1001)).toBe(0);
  });
});

describe("pull and push", () => {
  const state = () => ({ game: {}, actors: { user: { name: "Bea", hp: 5 } } }) as never;
  const rh = { paths: ["actors.*.hp"], ttlMs: 10_000, notes: { "actors.*.hp": "{name}: {old} to {value}" } };
  it("push writes only what changed; pull puts it back and tells an outside change once", async () => {
    const db = stateDb()!;
    const s = state();
    expect(await push(db, rh, { userId: "u1", actor: "user", state: s, now: 100 })).toBe(1);
    expect(await push(db, rh, { userId: "u1", actor: "user", state: s, now: 101 })).toBe(0);
    await db.updateTable("player_state").set({ value: "9", source: "external" }).execute();
    expect(await pull(db, rh, { userId: "u1", actor: "user", state: s, now: 102 })).toEqual(["Bea: 5 to 9"]);
    expect((s as any).actors.user.hp).toBe(9);
    expect(await pull(db, rh, { userId: "u1", actor: "user", state: s, now: 103 })).toEqual([]);
    expect((await rows())[0]).toMatchObject({ source: "game", expires_at: 10_103 });
  });
  it("expired rows are ignored, and free text or objects are never stored", async () => {
    const db = stateDb()!;
    const s = { game: {}, actors: { user: { name: "Bea", hp: { a: 1 } } } } as never;
    expect(await push(db, rh, { userId: "u1", actor: "user", state: s, now: 100 })).toBe(0);
    await push(db, rh, { userId: "u1", actor: "user", state: state(), now: 100 });
    const t = state(); (t as any).actors.user.hp = 1;
    await pull(db, rh, { userId: "u1", actor: "user", state: t, now: 99_999 });
    expect((t as any).actors.user.hp).toBe(1);
  });
});

describe("in the game", () => {
  it("a returning player gets the stored value, and an outside change is told to the narrator once", async () => {
    const t = makeChat(app, "a1");
    ollama.s.extractor.push([{ op: "set", path: "actors.user.hp", value: 7 }]);
    await t.send(bea, "Let's play"); await settle("chat:a1");
    expect(await rows()).toMatchObject([{ user_id: "u-bea", game: GAME, path: "actors.user.hp", value: "7", source: "game" }]);
    await stateDb()!.updateTable("player_state").set({ value: "9", source: "external" }).execute();
    await t.send(bea, "I look around"); await settle("chat:a1");
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).toContain("you's hp was set to 9 (was 7).");
    expect(sessions.get("chat:a1")!.snapshots.at(-1)!.actors.user.hp).toBe(9);
    await t.send(bea, "I wait"); await settle("chat:a1");
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).not.toContain("was set to");
    const t2 = makeChat(app, "a2"); // a new chat: the same person starts with what the database holds
    await t2.send(bea, "Let's play"); await settle("chat:a2");
    expect(sessions.get("chat:a2")!.snapshots.at(-1)!.actors.user.hp).toBe(9);
  });

  it("joining a table needs the flags: refused with the missing one, /optin sets it, then they join", async () => {
    const t = makeChat(app, "t1");
    await t.send(bea, "Let's play"); await settle("chat:t1");
    expect(await t.send(bo, "I follow her in")).toBe("You can't join this game yet: you still need opted_in.");
    expect(sessions.get("chat:t1")!.room?.players["u-bo"]).toBeUndefined();
    expect(await t.send(bo, "/optin")).toBe("You're opted in for the next game.");
    expect(await getMask(stateDb()!, cfg, "u-bo", Date.now(), GAME)).toBe(1);
    expect(await t.send(bo, "I follow her in")).not.toContain("can't join");
    expect(sessions.get("chat:t1")!.room!.players["u-bo"]).toBeDefined();
    expect(await t.send(bo, "/optout")).toBe("You're opted out of the next game.");
  });

  it("a busted player (hp 0) is blocked until the flag clears", async () => {
    const t = makeChat(app, "t2");
    ollama.s.extractor.push([{ op: "set", path: "actors.user.hp", value: 0 }]);
    await t.send(bea, "Let's play"); await settle("chat:t2");
    expect(await getMask(stateDb()!, cfg, "u-bea", Date.now(), GAME)).toBe(2);
  });

  it("with no database nothing changes", async () => {
    await stopState();
    const t = makeChat(app, "n1");
    expect(await t.send(bea, "Let's play")).toBe("The torch flickers.");
    expect(await t.send(bea, "/optin")).toBe("That needs the database, which is not on.");
  });
});

