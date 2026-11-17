import { describe, it, expect } from "@jest/globals";
import { runDoctor } from "../src/utils/doctor.js";
import { MIGRATION_NAMES } from "../src/utils/db-migrations.js";
import { makeSettings, makeSys } from "./fake-sys.js";

const want = { rules: "1", game: "1.0.0", proxy: "1.3.0", migrations: MIGRATION_NAMES };
const good = { applied: MIGRATION_NAMES, stamp: { rules: "1", game: "1.0.0", proxy: "1.3.0" } };
const run = async (state: unknown, howTo = "", url = "postgres://x") => {
  const sys = { ...makeSys({ files: howTo ? { "/game/HOW_TO_TEST.md": howTo } : {} }), dbState: async () => state } as never;
  const r = await runDoctor(sys, makeSettings({ databaseUrl: url, dbExpected: want } as never));
  return r.findings.filter((x) => x.id.startsWith("migrations-"));
};
const level = (fs: { id: string; level: string }[], id: string) => fs.find((x) => x.id === id)?.level;

describe("doctor: migrations", () => {
  it("says nothing without DATABASE_URL", async () => { expect(await run(good, "", "")).toEqual([]); });
  it("a database that matches is fine, and the game's recorded migration is checked", async () => {
    const f = await run(good, "Last database migration: 001_players");
    expect(level(f, "migrations-stamp")).toBe("ok");
    expect(level(f, "migrations-game")).toBe("ok");
  });
  it("reports an unreadable database", async () => { expect(level(await run({ error: "ECONNREFUSED" }), "migrations-reachable")).toBe("fail"); });
  it("reports pending, ahead and stamp differences as failures", async () => {
    expect(level(await run({ applied: [], stamp: {} }), "migrations-pending")).toBe("fail");
    expect(level(await run({ ...good, applied: [...MIGRATION_NAMES, "999_x"] }), "migrations-ahead")).toBe("fail");
    expect(level(await run({ ...good, stamp: { ...good.stamp, game: "2.0.0" } }), "migrations-stamp")).toBe("fail");
  });
  it("warns when the game was written against a migration the code or the database lacks, and informs when it records none", async () => {
    expect(level(await run(good, "Last database migration: 777_nope"), "migrations-game")).toBe("warn");
    expect(level(await run(good), "migrations-game")).toBe("info");
  });
});
