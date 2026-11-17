// 001_players
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  await db.schema.createTable("players").addColumn("user_id", "text", (c) => c.primaryKey()).addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull()).addColumn("seen_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull()).execute();
  await db.schema.createTable("stamp").addColumn("key", "text", (c) => c.primaryKey()).addColumn("value", "text", (c) => c.notNull()).execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("players").execute(); await db.schema.dropTable("stamp").execute(); 
}
