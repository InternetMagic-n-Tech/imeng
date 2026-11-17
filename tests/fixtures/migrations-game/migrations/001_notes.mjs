// A game's own migration: its tables are named <game>_<table>.
/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  await db.schema.createTable("fixture_notes").addColumn("id", "integer", (c) => c.primaryKey()).addColumn("body", "text", (c) => c.notNull()).execute();
}
/** @param {import("kysely").Kysely<any>} db */
export async function down(db) { await db.schema.dropTable("fixture_notes").execute(); }
