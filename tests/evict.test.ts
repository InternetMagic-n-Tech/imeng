import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/attach");
process.env.ATTACH_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evict-cache-"));
process.env.PROXY_API_KEY = "sekret-key-for-test";
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { startState, stopState, stateDb } = await import("../src/utils/db-state.js");
const B = await import("../src/utils/bucket.js");
const { evictPrefix } = await import("../src/utils/evict.js");

beforeEach(async () => {
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  const file = `sqlite:${process.env.SAVE_DIR}/e.sqlite`;
  await dbMain([], file, () => {});
  await startState(file, { exit: () => {} });
});
afterEach(async () => { await stopState(); B._useClient(null); jest.restoreAllMocks(); });

const seed = async () => {
  const store = new Map<string, Buffer>([["uploads/a/1", Buffer.from("x")], ["uploads/b/1", Buffer.from("y")]]);
  B._useClient({ bucketExists: async () => true, makeBucket: async () => {}, putObject: async () => {}, getObject: async () => { throw new Error("n/a"); }, removeObject: async (_b: string, k: string) => { store.delete(k); } } as any);
  const db = stateDb()!, now = Date.now();
  const att = (session: string, id: string, key: string) => ({ session, id, game: "g", user_id: null, thread: null, message_index: null, turn: null, source: "discord", sha256: id, mime: "image/png", bytes: 1, bucket_key: key, cached: 0, created_at: now, expires_at: now + 1e9 });
  await db.insertInto("attachments").values([att("discord:bot:chan1", "1", "uploads/a/1"), att("discord:bot:chan2", "1", "uploads/b/1")] as any).execute();
  await db.insertInto("pii_tokens").values([{ hash: "aa11bb", session: "discord:bot:chan1:u9", game: "g", kind: "uncle", first_seen: now, last_seen: now, expires_at: now + 1e9 }, { hash: "cc22dd", session: "discord:bot:chan2", game: "g", kind: "uncle", first_seen: now, last_seen: now, expires_at: now + 1e9 }]).execute();
  await db.insertInto("bans").values({ user_id: "u9", game: "g", thread: "discord:bot:chan1", reason: "", until: now + 1e6, created_at: now, expires_at: now + 1e9 }).execute();
  sessions.set("discord:bot:chan1", { snapshots: [] } as any);
  sessions.set("discord:bot:chan1:u9", { snapshots: [] } as any);
  sessions.set("discord:bot:chan2", { snapshots: [] } as any);
  return store;
};

describe("eviction", () => {
  it("drops a channel's sessions (also the per-person ones), rows and bucket files, and nobody else's", async () => {
    const store = await seed();
    const r = await evictPrefix("discord:bot:chan1");
    expect(r.chats).toBe(2);
    expect([...sessions.keys()]).toEqual(["discord:bot:chan2"]);
    expect([...store.keys()]).toEqual(["uploads/b/1"]);
    const db = stateDb()!;
    expect((await db.selectFrom("attachments").select("session").execute()).map((x) => x.session)).toEqual(["discord:bot:chan2"]);
    expect((await db.selectFrom("pii_tokens").select("session").execute()).map((x) => x.session)).toEqual(["discord:bot:chan2"]);
    expect(await db.selectFrom("bans").selectAll().execute()).toEqual([]);
  });
  it("does not take a longer channel id that merely starts the same", async () => {
    await seed();
    sessions.set("discord:bot:chan10", { snapshots: [] } as any);
    await evictPrefix("discord:bot:chan1");
    expect(sessions.has("discord:bot:chan10")).toBe(true);
  });
  it("the endpoint needs the key and a real prefix", async () => {
    await seed();
    expect((await request(app).post("/admin/evict").send({ prefix: "discord:bot:chan1" })).status).toBe(401);
    expect((await request(app).post("/admin/evict").set("authorization", "Bearer sekret-key-for-test").send({ prefix: "x" })).status).toBe(400);
    const ok = await request(app).post("/admin/evict").set("authorization", "Bearer sekret-key-for-test").send({ prefixes: ["discord:bot:chan1"] });
    expect(ok.status).toBe(200);
    expect(ok.body.evicted[0].chats).toBe(2);
  });
  it("money held by people of the chat is kept by default and logged without names or ids", async () => {
    await seed();
    const db = stateDb()!, now = Date.now();
    await db.insertInto("ledger").values({ game: "pii", user_id: "u9", debt: 300, credit: 0, banked: 4000, updated_at: now, expires_at: now + 1e9 } as any).execute();
    sessions.set("discord:bot:chan1", { snapshots: [], room: { players: { u9: { userId: "u9", name: "Bo" } } } } as any);
    const log = jest.spyOn(console, "log");
    await evictPrefix("discord:bot:chan1");
    expect((await db.selectFrom("ledger").selectAll().execute())).toHaveLength(1);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("balance(s) kept"))!;
    expect(line).toContain("1 balance(s) kept (debt 300, credit 0, banked 4000)");
    expect(line).not.toContain("u9"); expect(line).not.toContain("Bo");
  });
  it("finds chats under their real keys, which start with chat:", async () => {
    await seed();
    sessions.set("chat:discord:bot:chan1", { snapshots: [] } as any);
    sessions.set("chat:discord:bot:chan1:u9", { snapshots: [] } as any);
    sessions.set("chat:discord:bot:chan12", { snapshots: [] } as any);
    await evictPrefix("discord:bot:chan1");
    expect([...sessions.keys()].filter((k) => k.startsWith("chat:")).sort()).toEqual(["chat:discord:bot:chan12"]);
  });
});
