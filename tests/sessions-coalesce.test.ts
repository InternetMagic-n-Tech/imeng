import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";

process.env.SAVE_COALESCE_MS = "40";

const { sessions, saveSession, flushSaves, loadSessions } = await import("../src/utils/sessions.js");
const { initialState } = await import("../src/utils/state.js");
type Session = import("../src/utils/types.js").Session;

const SAVE_DIR = process.env.SAVE_DIR!;
const files = () => (fs.existsSync(SAVE_DIR) ? fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith(".json")) : []);
const sample = (turn = 0): Session => { const st = initialState(); st.game.turn = turn; return { snapshots: [st], unsynced: [], mode: "game", tail: Promise.resolve() }; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  sessions.clear(); fs.rmSync(SAVE_DIR, { recursive: true, force: true }); fs.mkdirSync(SAVE_DIR, { recursive: true });
  jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "log").mockImplementation(() => {});
});

describe("SAVE_COALESCE_MS", () => {
  it("does not write on the request path; the newest state is written once, later", async () => {
    const write = jest.spyOn(fs.promises, "writeFile");
    const s = sample(1);
    saveSession("chat:c", s);
    s.snapshots[0].game.turn = 2; saveSession("chat:c", s);
    s.snapshots[0].game.turn = 3; saveSession("chat:c", s);
    expect(files()).toEqual([]);
    await wait(150); await flushSaves();
    expect(files()).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(1);
    sessions.clear(); loadSessions();
    expect(sessions.get("chat:c")!.snapshots[0].game.turn).toBe(3);
    write.mockRestore();
  });

  it("flushSaves writes at once; an unchanged session is not rewritten", async () => {
    const write = jest.spyOn(fs.promises, "writeFile");
    const s = sample();
    saveSession("chat:u", s); await flushSaves();
    saveSession("chat:u", s); await flushSaves();
    expect(write).toHaveBeenCalledTimes(1);
    s.snapshots[0].game.turn = 9; saveSession("chat:u", s); await flushSaves();
    expect(write).toHaveBeenCalledTimes(2);
    write.mockRestore();
  });

  it("leaves no temporary file, and keeps a room with the session", async () => {
    const s = sample();
    s.room = { players: {}, order: [], talk: [], confirmed: [], notes: [], history: [{ role: "user", content: "hi" }], rounds: 1 };
    saveSession("room:r", s); await flushSaves();
    expect(fs.readdirSync(SAVE_DIR).some((f) => f.endsWith(".tmp"))).toBe(false);
    sessions.clear(); loadSessions();
    expect(sessions.get("room:r")!.room!.history).toEqual([{ role: "user", content: "hi" }]);
  });

  it("a failed write is kept for the next try", async () => {
    const write = jest.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    saveSession("chat:f", sample()); await flushSaves();
    expect(files()).toEqual([]);
    await flushSaves();
    expect(files()).toHaveLength(1);
    write.mockRestore();
  });
});
