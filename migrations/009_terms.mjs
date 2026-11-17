// 009_terms: who was sent a game's terms (the `terms` setting), once per person and game. Knex-style: `up` applies it, `down` reverses it.
// Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  await db.schema.createTable("terms_sent").addColumn("user_id", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull())
    .addColumn("sent_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("terms_sent_pk", ["user_id", "game"]).execute();
  await db.schema.createIndex("terms_sent_expires").on("terms_sent").column("expires_at").execute();
}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("terms_sent").execute();
}
