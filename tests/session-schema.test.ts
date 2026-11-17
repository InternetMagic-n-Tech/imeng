import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const S = await import("../src/utils/session-schema.js");
const { loadSessions, sessions, saveSession } = await import("../src/utils/sessions.js");
const { GAME_SCHEMA_VERSION } = await import("../src/utils/config.js");

const mig = (from: number, withSession = true): any => ({ from, to: from + 1, title: "t", up: (c: any) => c, down: (c: any) => c, notes: [], rollbackNotes: [], session: withSession ? (d: any) => ({ ...d, moved: true }) : undefined });

beforeEach(() => { for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear(); });
afterEach(() => { jest.restoreAllMocks(); });

describe("judgeSchema", () => {
  it("unstamped means 1; an equal stamp is fine; mode off checks nothing", () => {
    expect(S.stampOf({})).toBe(1);
    expect(S.stampOf({ schema_version: 3 })).toBe(3);
    expect(S.stampOf({ schema_version: 0 })).toBe(1);
    expect(S.judgeSchema({}, 1, "refuse").action).toBe("ok");
    expect(S.judgeSchema({ schema_version: 5 }, 1, "off").action).toBe("ok");
  });
  it("an older stamp migrates only when every step has a session migration; otherwise refuse or warn", () => {
    expect(S.judgeSchema({}, 3, "refuse", [mig(1), mig(2)]).action).toBe("migrate");
    expect(S.judgeSchema({}, 3, "refuse", [mig(1), mig(2, false)]).action).toBe("refuse");
    expect(S.judgeSchema({}, 3, "warn", []).action).toBe("warn");
  });
  it("a newer stamp has no way back", () => {
    const v = S.judgeSchema({ schema_version: 4 }, 2, "refuse", [mig(1)]);
    expect(v.action).toBe("refuse");
    expect(v.note).toContain("newer");
  });
  it("upgradeDoc runs each session step in order and restamps", () => {
    const out = S.upgradeDoc({ a: 1 }, 1, 3, [mig(1), mig(2)]);
    expect(out).toMatchObject({ a: 1, moved: true, schema_version: 3 });
  });
});

describe("startup scan", () => {
  it("names the sessions and the way out; warn and off never block; the scan is limited", () => {
    const docs = [{ key: "chat:a", doc: { schema_version: 2 } }, { key: "chat:b", doc: {} }, { key: "chat:c", doc: { schema_version: 2 } }];
    const msg = S.schemaProblem(docs, 1, "refuse")!;
    expect(msg).toContain("Refusing to start: 2 stored session(s)");
    expect(msg).toContain("chat:a (v2)");
    expect(msg).toContain("SESSION_SCHEMA=warn");
    expect(S.schemaProblem(docs, 1, "warn")).toBeNull();
    expect(S.schemaProblem(docs, 1, "refuse", undefined, 0)).toBeNull(); // limit 0: nothing scanned
    expect(S.schemaProblem([{ key: "k", doc: {} }], 1, "refuse")).toBeNull();
  });
});

describe("files", () => {
  const dir = () => process.env.SAVE_DIR!;
  beforeEach(() => { sessions.clear(); fs.rmSync(dir(), { recursive: true, force: true }); fs.mkdirSync(dir(), { recursive: true }); });
  const write = (name: string, doc: Record<string, unknown>) => fs.writeFileSync(path.join(dir(), name), JSON.stringify({ snapshots: [{ game: {}, actors: {} }], ...doc }));

  it("a save is stamped with the game's schema_version and reloads", () => {
    saveSession("chat:x", { snapshots: [{ game: {}, actors: {} } as any], unsynced: [], tail: Promise.resolve() } as any);
    const saved = JSON.parse(fs.readFileSync(path.join(dir(), fs.readdirSync(dir())[0]), "utf8"));
    expect(saved.schema_version).toBe(GAME_SCHEMA_VERSION);
    sessions.clear();
    loadSessions();
    expect(sessions.has("chat:x")).toBe(true);
  });
  it("a legacy unstamped save loads; a save from another version stops the load (it is not skipped and later overwritten)", () => {
    write("a.json", { key: "chat:old" });
    loadSessions();
    expect(sessions.has("chat:old")).toBe(true);
    sessions.clear();
    write("b.json", { key: "chat:new", schema_version: GAME_SCHEMA_VERSION + 1 });
    expect(() => loadSessions()).toThrow(S.SchemaMismatch);
  });
});
