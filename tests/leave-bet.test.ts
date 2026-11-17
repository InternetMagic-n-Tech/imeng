import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-bet");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { startState, stopState } = await import("../src/utils/db-state.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" };
const TABLE = "cccccccc-3333-4333-8333-cccccccccccc", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(async () => {
  ollama.reset(); ollama.s.narration = "The dealer nods.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  const file = `sqlite:${process.env.SAVE_DIR}/l.sqlite`;
  await dbMain([], file, () => {}); await startState(file, { exit: () => {} });
});
afterEach(async () => { await stopState(); });

describe("leaving a hand at a table (through the app)", () => {
  for (const rule of ["fold", "split"] as const) {
    it(`leave_rule ${rule}: the server settles the leaver's seat and the hand goes on`, async () => {
      const t = makeChat(app, TABLE);
      await t.send(bea, "Let's play"); await settle();
      await t.send(bo, "I follow her in"); await settle();
      const s = sessions.get(KEY)!, boSeat = s.room!.players[bo.id].actor;
      let st: any = s.snapshots.at(-1)!;
      const beaSeat = s.room!.players[bea.id].actor;
      st.actors[boSeat] ??= { ...structuredClone(st.actors[beaSeat]), name: "Bo", controlled_by: "other_player" };
      st.game.phase = "preflop"; st.game.leave_rule = rule;
      for (const [k, a] of Object.entries<any>(st.actors)) if (k !== "table" && k !== boSeat && k !== beaSeat) a.status = "sitting out";
      st = await runPhaseHook(st, "registration", "state", undefined, s);
      s.snapshots[s.snapshots.length - 1] = st;
      const said = await t.send(bo, "leave the table"); await settle();
      expect(said).toMatch(/^Bo has left the table\./);
      expect(said).toMatch(rule === "fold" ? /leaves and folds/ : /leaves and stays in for/);
      const after: any = sessions.get(KEY)!.snapshots.at(-1)!;
      expect(["folded", "all-in", "sitting out"]).toContain(after.actors[boSeat].status);
    });
  }
});
