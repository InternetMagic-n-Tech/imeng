import { describe, it, expect } from "@jest/globals";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/migrations-game");
const M = await import("../src/utils/db-migrations.js");
const { openDb } = await import("../src/utils/db.js");
const { judgeState } = await import("../src/utils/state-guard.js");
const { shippedGames, dbMain } = await import("../src/utils/db-cli.js");
const { expectedStamp } = await import("../src/utils/db-state.js");

const GAME = path.join(process.cwd(), "tests/fixtures/migrations-game/migrations");
const memdb = async (): Promise<any> => { const db = await openDb("sqlite::memory:"); return db; };

describe("migrations are files with an up and a down", () => {
  it("the engine's folder holds 001 to 008, in order, and only NNN_name.mjs files count", async () => {
    expect(M.MIGRATION_NAMES[0]).toBe("001_players");
    expect(M.MIGRATION_NAMES).toEqual([...M.MIGRATION_NAMES].sort());
    expect(M.MIGRATION_NAMES).toContain("008_code_terms");
    expect(M.migrationNames(GAME)).toEqual(["001_notes", "002_notes_author"]); // README.md and _template.mjs are ignored
    expect(M.migrationNames("/no/such/folder")).toEqual([]);
  });
  it("every engine migration exports up and down", async () => {
    for (const n of M.MIGRATION_NAMES) { const mod = await import(path.join(M.engineDir(), `${n}.mjs`)); expect(typeof mod.up).toBe("function"); expect(typeof mod.down).toBe("function"); }
  });
  it("a file without up(db) is refused", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mig-")); fs.writeFileSync(path.join(d, "001_bad.mjs"), "export const x = 1;\n");
    await expect(M.fileProvider(d).getMigrations()).rejects.toThrow(/no up\(db\)/);
  });
  it("a game's own migrations run after the engine's, in a table of their own, and are judged like the engine's", async () => {
    const db = await memdb(), want = expectedStamp();
    expect(want.gameId).toBeTruthy(); expect(want.gameMigrations).toEqual(["001_notes", "002_notes_author"]);
    const ran = await M.migrateUp(db, want);
    expect(ran).toEqual([...M.MIGRATION_NAMES, `${want.gameId}/001_notes`, `${want.gameId}/002_notes_author`]);
    await db.insertInto("fixture_notes" as never).values({ id: 1, body: "hi", author: "bea" } as never).execute();
    const st = await M.readState(db, want.gameId);
    expect(st.appliedGame).toEqual(["001_notes", "002_notes_author"]);
    expect(judgeState(st, want).ok).toBe(true);
    expect(judgeState({ ...st, appliedGame: ["001_notes"] }, want).reason).toMatch(/game's migrations are pending/);
    expect(judgeState({ ...st, appliedGame: [...st.appliedGame!, "009_future"] }, want).reason).toMatch(/game's database is ahead/);
    expect(await M.migrateUp(db, want)).toEqual([]); // nothing left to do
    await db.destroy();
  });
  it("a game without migrations has no game table and nothing to judge", async () => {
    const db = await memdb();
    const want = { ...expectedStamp(), gameMigrations: undefined, gameDir: undefined };
    await M.migrateUp(db, want);
    const st = await M.readState(db, "nothing");
    expect(st.appliedGame).toEqual([]);
    expect(judgeState(st, want).ok).toBe(true);
    await db.destroy();
  });
  it("--all migrates every imeng folder that ships migrations (the compose migrate service)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "games-"));
    for (const [name, id] of [["alpha", "alpha-game"], ["nested/beta", "beta-game"]]) { const d = path.join(root, name); fs.mkdirSync(path.join(d, "migrations"), { recursive: true }); fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ model_id: id })); fs.copyFileSync(path.join(GAME, "001_notes.mjs"), path.join(d, "migrations", "001_notes.mjs")); }
    const js = path.join(root, "js-game"); fs.mkdirSync(path.join(js, "migrations"), { recursive: true }); fs.writeFileSync(path.join(js, "config.mjs"), "export default { model_id: 'js-game' };\n");
    fs.writeFileSync(path.join(js, "migrations", "001_x.mjs"), "export async function up() {}\nexport async function down() {}\n");
    fs.mkdirSync(path.join(root, "plain")); fs.writeFileSync(path.join(root, "plain", "config.json"), JSON.stringify({ model_id: "plain" }));
    expect((await shippedGames(root)).map((g) => g.id).sort()).toEqual(["alpha-game", "beta-game", "js-game"]);
    expect(M.gameTable("Alpha-Game")).toBe("kysely_migration_alpha_game");
  });
  it("db:migrate --status says where it stands", async () => {
    const lines: string[] = [];
    expect(await dbMain(["--status"], "sqlite::memory:", (m) => lines.push(m))).toBe(1); // a fresh database is behind
    expect(lines[0]).toMatch(/pending|ahead|differs/);
  });
});
