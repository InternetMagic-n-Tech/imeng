// 004_bans_and_pii_tokens
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // A temporary ban from a table (a player who looked at another's cards): ignored by the deal, the private channel and the narrator until `until`. One row per person, game and table.
  await db.schema.createTable("bans").addColumn("user_id", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull()).addColumn("thread", "text", (c) => c.notNull())
    .addColumn("reason", "text", (c) => c.notNull().defaultTo("")).addColumn("until", "bigint", (c) => c.notNull()).addColumn("created_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("bans_pk", ["user_id", "game", "thread"]).execute();
  await db.schema.createIndex("bans_expires").on("bans").column("expires_at").execute();
  // Which PII tokens a session has used: the salted hash is the key, never the value, and the session is the second key, so a resumed chat can refresh its tokens and a deleted chat takes its rows with it.
  await db.schema.createTable("pii_tokens").addColumn("hash", "text", (c) => c.notNull()).addColumn("session", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull()).addColumn("first_seen", "bigint", (c) => c.notNull()).addColumn("last_seen", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("pii_tokens_pk", ["hash", "session"]).execute();
  await db.schema.createIndex("pii_tokens_expires").on("pii_tokens").column("expires_at").execute();
  await db.schema.createIndex("pii_tokens_session").on("pii_tokens").column("session").execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("bans").execute(); await db.schema.dropTable("pii_tokens").execute(); 
}
