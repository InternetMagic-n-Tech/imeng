import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import fs from "node:fs";
import type { Session } from "../src/utils/types.js";

jest.unstable_mockModule("../src/utils/cli.js", () => ({ PERSIST: false, parseArgs: () => ({ persist: false }) }));

const SAVE_DIR = process.env.SAVE_DIR!;
let mod: typeof import("../src/utils/sessions.js");
let state: typeof import("../src/utils/state.js");

beforeAll(async () => {
  mod = await import("../src/utils/sessions.js");
  state = await import("../src/utils/state.js");
});

describe("sessions with --no-persist", () => {
  it("never touches the disk", () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const s: Session = { snapshots: [state.initialState()], unsynced: [], tail: Promise.resolve() };
    mod.saveSession("chat:x", s);
    mod.loadSessions();
    expect(fs.existsSync(SAVE_DIR)).toBe(false);
    expect(console.log).toHaveBeenCalledWith("--no-persist: sessions are kept in memory only");
  });

  it("still keeps sessions in memory and promotes without touching files", () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const req = { get: () => undefined };
    const [, s, promote] = mod.sessionFor(req, [{ role: "user", content: "Play" }]);
    const key = promote!("reply");
    expect(mod.sessions.get(key)).toBe(s);
    const [k2] = mod.sessionFor(req, [{ role: "user", content: "Play" }, { role: "assistant", content: "other" }, { role: "user", content: "x" }]);
    expect(k2.startsWith("hash:")).toBe(true);
    expect(fs.existsSync(SAVE_DIR)).toBe(false);
  });
});
