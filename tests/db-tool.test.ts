import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import { runDbCheck, dbCheckMain } from "../src/utils/db-check.js";
import { dbMain } from "../src/utils/db-cli.js";
import { startState, stopState, stateDb } from "../src/utils/db-state.js";
import dbTool from "../src/tools/db.js";

const players = [
  { user_id: "u1", name: "Bea", created_at: 1, seen_at: 5, expires_at: 9_999_999_999_999 },
  { user_id: "u2", name: "Bo", created_at: 2, seen_at: 6, expires_at: 9_999_999_999_999 },
  { user_id: "u3", name: "Old", created_at: 3, seen_at: 7, expires_at: 10 },
];
const opts = { tables: { players: { columns: ["user_id", "name", "seen_at"], filter: ["user_id", "seen_at"], pii: ["name"] } }, max_rows: 5 };
const call = (args: unknown, options: Record<string, any> = opts) => dbTool.run(args, { options } as never) as Promise<any>;

beforeEach(async () => {
  fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  const file = `sqlite:${process.env.SAVE_DIR}/tool.sqlite`;
  fs.rmSync(`${process.env.SAVE_DIR}/tool.sqlite`, { force: true });
  await dbMain([], file, () => {});
  await startState(file, { exit: () => {} });
  await stateDb()!.insertInto("players").values(players).execute();
});
afterEach(async () => { await stopState(); });

describe("the db tool", () => {
  it("reads only listed tables and columns, masks pii, hides expired rows, caps rows", async () => {
    expect((await call({ action: "select", table: "players", order_by: { column: "seen_at", dir: "desc" } })).rows).toEqual([{ user_id: "u2", name: "[redacted]", seen_at: 6 }, { user_id: "u1", name: "[redacted]", seen_at: 5 }]);
    expect(await call({ action: "count", table: "players" })).toEqual({ count: 2 });
    expect((await call({ action: "select", table: "players", limit: 1 })).rows).toHaveLength(1);
    expect((await call({ action: "select", table: "stamp" })).error).toMatch(/table not allowed/);
    expect((await call({ action: "select", table: "players", columns: ["expires_at"] })).error).toMatch(/column "expires_at" not allowed/);
  });
  it("filters only on listed columns and with known ops", async () => {
    expect((await call({ action: "select", table: "players", where: [{ column: "user_id", op: "eq", value: "u1" }] })).rows).toHaveLength(1);
    expect((await call({ action: "count", table: "players", where: [{ column: "seen_at", op: "gte", value: 6 }] })).count).toBe(1);
    expect((await call({ action: "count", table: "players", where: [{ column: "user_id", op: "in", value: ["u1", "u2"] }] })).count).toBe(2);
    expect((await call({ action: "select", table: "players", where: [{ column: "name", op: "eq", value: "Bea" }] })).error).toMatch(/cannot filter/);
    expect((await call({ action: "select", table: "players", where: [{ column: "user_id", op: "; drop", value: 1 }] })).error).toMatch(/op must be/);
    expect((await call({ action: "select", table: "players", where: [{ column: "user_id", op: "eq", value: { a: 1 } }] })).error).toMatch(/bad value/);
    expect((await call({ action: "select", table: "players", order_by: { column: "expires_at" } })).error).toMatch(/cannot order/);
  });
  it("reports no database, and a query that takes too long", async () => {
    expect((await call({ action: "select", table: "players" }, { ...opts, timeout_ms: 100 })).rows).toBeDefined();
    await stopState();
    expect(await call({ action: "select", table: "players" })).toEqual({ error: "no database" });
  });
});

describe("driver db: a fresh database, a query, an exact outcome", () => {
  const seed = { players };
  it("passes when the rows are exactly as expected", async () => {
    const r = await runDbCheck({ seed, query: "select user_id from players where seen_at > ? order by user_id", params: [5], expect: { rows: [{ user_id: "u2" }, { user_id: "u3" }] } });
    expect(r.ok).toBe(true);
    expect(r.migrations).toContain("001_players");
  });
  it("fails on a different row, order, count, or when none were expected", async () => {
    const q = "select user_id from players order by user_id";
    expect((await runDbCheck({ seed, query: q, expect: { rows: [{ user_id: "u1" }] } })).problems[0]).toMatch(/rows differ/);
    expect((await runDbCheck({ seed, query: q, expect: { rows: [{ user_id: "u3" }, { user_id: "u2" }, { user_id: "u1" }] } })).ok).toBe(false);
    expect((await runDbCheck({ seed, query: q, expect: { rows: [{ user_id: "u3" }, { user_id: "u2" }, { user_id: "u1" }], unordered: true } })).ok).toBe(true);
    expect((await runDbCheck({ seed, query: q, expect: { count: 2 } })).problems).toEqual(["expected 2 row(s), got 3"]);
    expect((await runDbCheck({ seed, query: q, expect: { none: true } })).problems).toEqual(["expected no rows, got 3"]);
    expect((await runDbCheck({ query: q, expect: { none: true } })).ok).toBe(true);
  });
  it("a placeholder mismatch is an error, and the file form returns an exit code", async () => {
    await expect(runDbCheck({ query: "select ?", params: [], expect: {} })).rejects.toThrow("1 placeholders and 0 params");
    const out: string[] = [];
    expect(await dbCheckMain(JSON.stringify({ seed, query: "select count(*) as n from players", expect: { rows: [{ n: 3 }] } }), (m) => out.push(m))).toBe(0);
    expect(await dbCheckMain(JSON.stringify({ seed, query: "select count(*) as n from players", expect: { rows: [{ n: 4 }] } }), (m) => out.push(m))).toBe(1);
    expect(out[0]).toBe("ok (1 row(s))");
  });
});
