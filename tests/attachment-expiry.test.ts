import { describe, it, expect, jest } from "@jest/globals";
import { openDb } from "../src/utils/db.js";
import { migrateUp } from "../src/utils/db-migrations.js";
import { cleanExpired } from "../src/utils/db-cleanup.js";
import { expectedStamp } from "../src/utils/db-state.js";

const B = await import("../src/utils/bucket.js");

describe("expired attachments", () => {
  it("deletes the bucket object with the row, and keeps a row whose object could not be deleted for the next run", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Map<string, Buffer>([["uploads/s/a", Buffer.from("x")], ["uploads/s/b", Buffer.from("y")], ["uploads/s/c", Buffer.from("z")]]);
    let failB = true;
    B._useClient({
      bucketExists: async () => true, makeBucket: async () => {}, putObject: async () => {}, getObject: async () => { throw new Error("n/a"); },
      removeObject: async (_b: string, k: string) => { if (k === "uploads/s/b" && failB) throw new Error("down"); store.delete(k); },
    } as any);
    const db = await openDb("sqlite::memory:");
    await migrateUp(db, expectedStamp());
    const row = (id: string, exp: number) => ({ session: "s", id, game: "g", user_id: null, thread: null, message_index: null, turn: null, source: "other", sha256: id, mime: "image/png", bytes: 1, bucket_key: `uploads/s/${id}`, cached: 0, created_at: 1, expires_at: exp });
    await db.insertInto("attachments").values([row("a", 100), row("b", 100), row("c", 900)] as any).execute();
    expect(await cleanExpired(db, 500)).toMatchObject({ attachments: 1 });
    expect([...store.keys()].sort()).toEqual(["uploads/s/b", "uploads/s/c"]); // a is gone; b failed; c has not expired
    expect((await db.selectFrom("attachments").select("id").execute()).map((r) => r.id).sort()).toEqual(["b", "c"]);
    failB = false;
    await cleanExpired(db, 500);
    expect([...store.keys()]).toEqual(["uploads/s/c"]);
    expect((await db.selectFrom("attachments").select("id").execute()).map((r) => r.id)).toEqual(["c"]);
    B._useClient(null);
    await db.destroy();
  });
});
