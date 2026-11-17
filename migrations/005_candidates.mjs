// 005_candidates
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // Who could own a chat next: one row per person and chat, refreshed as they speak. Score is computed in code; a chat's rows go with the chat.
  await db.schema.createTable("candidates").addColumn("thread", "text", (c) => c.notNull()).addColumn("user_id", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull()).addColumn("score", "real", (c) => c.notNull()).addColumn("msgs", "integer", (c) => c.notNull().defaultTo(0)).addColumn("last_seen", "bigint", (c) => c.notNull())
    .addColumn("expires_at", "bigint", (c) => c.notNull()).addPrimaryKeyConstraint("candidates_pk", ["thread", "user_id"]).execute();
  await db.schema.createIndex("candidates_expires").on("candidates").column("expires_at").execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("candidates").execute(); 
}
