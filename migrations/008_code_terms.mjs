// 008_code_terms
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // The terms a re-entry code was issued under (the table's starting stack and the unit), so an outside payment service cannot change the value or the currency afterwards.
  await db.schema.alterTable("reentry_codes").addColumn("price", "integer").execute();
  await db.schema.alterTable("reentry_codes").addColumn("currency", "text").execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.alterTable("reentry_codes").dropColumn("price").execute(); await db.schema.alterTable("reentry_codes").dropColumn("currency").execute(); 
}
