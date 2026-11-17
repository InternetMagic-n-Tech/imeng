/** @param {import("kysely").Kysely<any>} db */
export async function up(db) { await db.schema.alterTable("fixture_notes").addColumn("author", "text").execute(); }
export async function down(db) { await db.schema.alterTable("fixture_notes").dropColumn("author").execute(); }
