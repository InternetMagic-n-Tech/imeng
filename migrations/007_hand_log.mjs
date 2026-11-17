// 007_hand_log
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // Append-only copy of a server-kept hand (the deal's deck and hole cards, every bet), keyed by session and turn: a rollback deletes the rows after its turn. The snapshots stay the truth; this is the house's record.
  await db.schema.createTable("hand_log").addColumn("session", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull())
    .addColumn("turn", "integer", (c) => c.notNull()).addColumn("hand", "integer", (c) => c.notNull().defaultTo(0)).addColumn("kind", "text", (c) => c.notNull()).addColumn("body", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull()).execute();
  await db.schema.createIndex("hand_log_session").on("hand_log").columns(["session", "turn"]).execute();
  await db.schema.createIndex("hand_log_expires").on("hand_log").column("expires_at").execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("hand_log").execute(); 
}
