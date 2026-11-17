import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet");
const { betCommand } = await import("../src/utils/poker-bet-turn.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");
const { startState, stopState, stateDb, expectedStamp } = await import("../src/utils/db-state.js");
const { openDb } = await import("../src/utils/db.js");
const { migrateUp } = await import("../src/utils/db-migrations.js");
const { trimHandLog, logHand } = await import("../src/utils/hand-log.js");
const { bootstrap } = await import("../src/utils/bootstrap.js");

beforeEach(() => { for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });
afterEach(async () => { await stopState(); jest.restoreAllMocks(); });

describe("the database copy of a hand", () => {
  it("keeps the deal and every bet, and a rollback deletes what came after its turn", async () => {
    const file = path.join(os.tmpdir(), `hand-log-${process.pid}.db`); fs.rmSync(file, { force: true });
    const pre = await openDb(`sqlite:${file}`); await migrateUp(pre, expectedStamp()); await pre.destroy();
    await startState(`sqlite:${file}`);
    const st: any = initialState(); st.game.phase = "preflop";
    const s: any = { room: { players: { u: { actor: "user" } } }, snapshots: [] };
    s.snapshots = [st];
    s.snapshots[0] = await runPhaseHook(st, "registration", "state", undefined, s);
    await betCommand("call", { session: s, who: { userId: "u", name: "Bea" } });
    const rows = await stateDb()!.selectFrom("hand_log").selectAll().orderBy("created_at").execute();
    expect(rows.map((r: any) => r.kind)).toEqual(expect.arrayContaining(["deal", "bet"]));
    expect(rows.every((r: any) => r.session === s.logId && r.turn === 1)).toBe(true);
    expect(JSON.parse(String(rows.find((r: any) => r.kind === "deal")!.body)).ops.length).toBeGreaterThan(0);
    s.snapshots.push(structuredClone(s.snapshots[0]));
    await logHand(s, s.snapshots[1], "bet", { later: true });
    await trimHandLog(s, 1);
    expect((await stateDb()!.selectFrom("hand_log").select("body").execute()).some((r: any) => r.body.includes("later"))).toBe(false);
    expect((await stateDb()!.selectFrom("hand_log").selectAll().execute()).length).toBe(rows.length);
    fs.rmSync(file, { force: true });
  });
  it("without a database nothing is written and nothing breaks; a write that fails is only a warning", async () => {
    const s: any = { snapshots: [initialState()] };
    await logHand(s, s.snapshots[0], "bet", {}); expect(s.logId).toBeUndefined();
    await trimHandLog(s, 0);
    await startState("sqlite::memory:", { exit: () => {} }); // not migrated: the table is missing
    await logHand(s, s.snapshots[0], "bet", {});
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("hand log not written"));
    s.logId = "x"; await trimHandLog(s, 0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("hand log not trimmed"));
  });
  it("a bet while the bookkeeper's stamp is wrong pauses the table; a server-dealt game will not start without a database", async () => {
    await startState("sqlite::memory:", { exit: () => {} }); // never migrated: the stamp does not match
    const st: any = initialState(); st.game.phase = "preflop";
    const s: any = { room: { players: { u: { actor: "user" } } }, snapshots: [await runPhaseHook(st, "registration", "state")] };
    expect(await betCommand("call", { session: s, who: { userId: "u", name: "Bea" } })).toMatch(/unavailable/i);
    await stopState();
    expect(await bootstrap({ preflight: false, port: 0 })).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
  });
});
