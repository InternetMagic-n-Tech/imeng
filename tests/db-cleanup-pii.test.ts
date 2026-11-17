import { describe, it, expect, jest } from "@jest/globals";
import fs from "node:fs";
import { openDb } from "../src/utils/db.js";
import { migrateUp } from "../src/utils/db-migrations.js";
import { cleanExpired, cleanupMain } from "../src/utils/db-cleanup.js";
import { redactPii, piiStored } from "../src/utils/pii.js";
import { expectedStamp } from "../src/utils/db-state.js";

describe("cleanExpired", () => {
  it("removes only expired rows, from tables that have an expiry", async () => {
    const db = await openDb("sqlite::memory:");
    await migrateUp(db, expectedStamp());
    await db.insertInto("players").values([{ user_id: "a", name: "A", created_at: 1, seen_at: 1, expires_at: 100 }, { user_id: "b", name: "B", created_at: 1, seen_at: 1, expires_at: 300 }]).execute();
    expect(await cleanExpired(db, 200)).toMatchObject({ players: 1 });
    expect((await db.selectFrom("players").select("user_id").execute()).map((r) => r.user_id)).toEqual(["b"]);
    expect((await db.selectFrom("stamp").selectAll().execute()).length).toBe(3); // no expiry column: untouched
    await db.destroy();
  });

  it("cleanupMain runs once, or repeatedly until stopped, and needs a url", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const out: string[] = [];
    expect(await cleanupMain([], "", (m) => out.push(m))).toBe(1);
    fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
    const file = `sqlite:${process.env.SAVE_DIR}/clean.sqlite`;
    const db = await openDb(file); await migrateUp(db, expectedStamp()); await db.destroy();
    expect(await cleanupMain([], file, (m) => out.push(m))).toBe(0);
    expect(out.at(-1)).toContain('"players":0');
    const ac = new AbortController();
    const run = cleanupMain(["--every", "1000"], file, (m) => out.push(m), ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await run).toBe(0);
    jest.restoreAllMocks();
  });
});

describe("redactPii", () => {
  const state = { actors: { user: { real_name: "Bea Lee", score: 1 }, npc: { real_name: "", score: 0 } }, game: { contact: "a@b.c", turn: 2 } };
  it("masks listed paths (with * for one key), skips empty values, and never changes the input", () => {
    const out = redactPii(state, ["actors.*.real_name", "game.contact", "game.missing.x"]);
    expect(out.actors.user.real_name).toBe("[redacted]");
    expect(out.actors.npc.real_name).toBe("");
    expect(out.game.contact).toBe("[redacted]");
    expect(out.actors.user.score).toBe(1);
    expect(state.actors.user.real_name).toBe("Bea Lee");
    expect(redactPii(state, ["game.contact"], "***").game.contact).toBe("***");
  });
  it("with no paths the value comes back as it is", () => { expect(redactPii(state, [])).toBe(state); });
  it("finds stored paths that are personal", () => {
    expect(piiStored(["actors.user.score", "actors.user.real_name", "game.contact"], ["actors.*.real_name", "game.contact"])).toEqual(["actors.user.real_name", "game.contact"]);
  });
});
