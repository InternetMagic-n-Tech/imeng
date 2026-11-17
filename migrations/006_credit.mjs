// 006_credit
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // A player's debt to the house (per game, not per chat: a chat's end does not wipe what is owed). Rows keep a long expiry that every change pushes out.
  await db.schema.createTable("ledger").addColumn("game", "text", (c) => c.notNull()).addColumn("user_id", "text", (c) => c.notNull()).addColumn("debt", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("credit", "integer", (c) => c.notNull().defaultTo(0)).addColumn("banked", "integer", (c) => c.notNull().defaultTo(0)).addColumn("updated_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("ledger_pk", ["game", "user_id"]).execute();
  await db.schema.createIndex("ledger_expires").on("ledger").column("expires_at").execute();
  // Re-entry codes: `valid_until` is when the code stops working; the row itself lives 30 days longer (`expires_at`) so the owner can still be told. Only the hash of a code is kept; single use, expiring. `paid` is set by the outside service (or the owner) with a state change.
  await db.schema.createTable("reentry_codes").addColumn("code_hash", "text", (c) => c.primaryKey()).addColumn("game", "text", (c) => c.notNull()).addColumn("thread", "text", (c) => c.notNull())
    .addColumn("user_id", "text", (c) => c.notNull()).addColumn("paid", "integer", (c) => c.notNull().defaultTo(0)).addColumn("used_at", "bigint").addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("valid_until", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull()).addColumn("told_owner", "integer", (c) => c.notNull().defaultTo(0)).execute();
  await db.schema.createIndex("reentry_user").on("reentry_codes").columns(["game", "user_id"]).execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("ledger").execute(); await db.schema.dropTable("reentry_codes").execute(); 
}
