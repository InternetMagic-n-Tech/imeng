import { describe, it, expect } from "@jest/globals";
import { openDb } from "../src/utils/db.js";
import { migrateUp } from "../src/utils/db-migrations.js";
import { cleanExpired } from "../src/utils/db-cleanup.js";
import { expectedStamp } from "../src/utils/db-state.js";

describe("the bans and pii_tokens tables", () => {
  it("exist after migration, key a token by hash and session, and are cleaned when expired", async () => {
    const db = await openDb("sqlite::memory:");
    await migrateUp(db, expectedStamp());
    const now = Date.now();
    await db.insertInto("bans").values({ user_id: "u1", game: "g", thread: "t", reason: "", until: now + 1000, created_at: now, expires_at: now - 1 }).execute();
    await db.insertInto("pii_tokens").values([
      { hash: "3fa9c2", session: "s1", game: "g", kind: "uncle", first_seen: now, last_seen: now, expires_at: now - 1 },
      { hash: "3fa9c2", session: "s2", game: "g", kind: "uncle", first_seen: now, last_seen: now, expires_at: now + 10_000 }]).execute();
    await expect(db.insertInto("pii_tokens").values({ hash: "3fa9c2", session: "s2", game: "g", kind: "uncle", first_seen: now, last_seen: now, expires_at: now + 1 }).execute()).rejects.toThrow(); // same hash and session twice
    expect(await cleanExpired(db, now)).toMatchObject({ bans: 1, pii_tokens: 1 });
    expect((await db.selectFrom("pii_tokens").select("session").execute()).map((r) => r.session)).toEqual(["s2"]);
    await db.destroy();
  });
});
