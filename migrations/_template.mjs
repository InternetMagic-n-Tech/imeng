// NNN_what_it_does: copy this file to the next number (for example 009_players_nickname.mjs). Knex-style: `up` applies it, `down` reverses it.
// Never edit a migration that has shipped. An imeng's own migrations go in imengs/<game>/migrations and name their tables <game>_<table>.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  await db.schema.createTable("example").addColumn("id", "text", (c) => c.primaryKey()).addColumn("created_at", "bigint", (c) => c.notNull()).execute();
}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("example").execute();
}
