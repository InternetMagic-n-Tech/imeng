// 002_rehydrate_eligibility
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // The numbers, booleans and ids a game keeps per person (config.json rehydrate). source: "game" = written by the proxy, "external" = changed by something else and not yet told.
  await db.schema.createTable("player_state").addColumn("user_id", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull()).addColumn("path", "text", (c) => c.notNull())
    .addColumn("value", "text", (c) => c.notNull()).addColumn("source", "text", (c) => c.notNull().defaultTo("external")).addColumn("updated_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("player_state_pk", ["user_id", "game", "path"]).execute();
  await db.schema.createIndex("player_state_expires").on("player_state").column("expires_at").execute();
  await db.schema.createTable("eligibility").addColumn("user_id", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull()).addColumn("mask", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("version", "integer", (c) => c.notNull()).addColumn("updated_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("eligibility_pk", ["user_id", "game"]).execute();
  await db.schema.createIndex("eligibility_expires").on("eligibility").column("expires_at").execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("player_state").execute(); await db.schema.dropTable("eligibility").execute(); 
}
