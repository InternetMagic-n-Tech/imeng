// 003_attachments
// Knex-style: `up` applies the migration, `down` reverses it. Never edit a migration that has shipped: add a new one.

/** @param {import("kysely").Kysely<any>} db */
export async function up(db) {
  // Files that people attached to a message (images Open WebUI or Discord sent that did not come from us). The bytes live in the bucket (and in _cache/ until it takes them); this says which message, chat, thread and person each belongs to.
  await db.schema.createTable("attachments").addColumn("session", "text", (c) => c.notNull()).addColumn("id", "text", (c) => c.notNull()).addColumn("game", "text", (c) => c.notNull())
    .addColumn("user_id", "text").addColumn("thread", "text").addColumn("message_index", "integer").addColumn("turn", "integer").addColumn("source", "text", (c) => c.notNull())
    .addColumn("sha256", "text", (c) => c.notNull()).addColumn("mime", "text", (c) => c.notNull()).addColumn("bytes", "integer", (c) => c.notNull())
    .addColumn("bucket_key", "text").addColumn("cached", "integer", (c) => c.notNull().defaultTo(0)).addColumn("created_at", "bigint", (c) => c.notNull()).addColumn("expires_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("attachments_pk", ["session", "id"]).execute();
  await db.schema.createIndex("attachments_expires").on("attachments").column("expires_at").execute();
  await db.schema.createIndex("attachments_sha").on("attachments").column("sha256").execute();

}

/** @param {import("kysely").Kysely<any>} db */
export async function down(db) {
  await db.schema.dropTable("attachments").execute(); 
}
