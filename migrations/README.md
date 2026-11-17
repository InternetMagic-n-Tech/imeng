# Migrations

Two kinds of file live here, both in the order they are needed.

## Database migrations (`NNN_name.mjs`), Knex-style
One file per change to the bookkeeping database (`DATABASE_URL`). Each exports `up(db)` and `down(db)`, where `db` is a Kysely instance (`db.schema...`, `db.insertInto(...)`). Names sort in the order they run; Kysely records what ran in `kysely_migration`.
`npm run db:migrate` applies the pending ones and writes the version stamp (`--status` only reports; `--all` also runs every imeng's own, as the compose `migrate` service does). The server refuses to start while the database is behind or ahead of this folder. `_template.mjs` is the shape to copy; files that do not match `NNN_name.mjs` are ignored.

- **Never edit a migration that has shipped.** Add a new one (next number), and update the "Last database migration" line in each affected game's `HOW_TO_TEST.md`.
- Review every new query's plan (`EXPLAIN`) before it ships: no unindexed scans on a growing table, no unbounded reads.
- **An imeng has its own migrations** in `imengs/<game>/migrations/NNN_name.mjs`, same shape, recorded in a table of their own (`kysely_migration_<game>`) and run after the engine's. A game's tables are named `<game>_<table>`; it never touches the engine's tables. The doctor and the startup check judge them the same way.
- Set `MIGRATIONS_DIR` to read the engine's migrations from another folder.

## Version notes (`<from>-to-<to>.md`), one per minor version
What changed for someone moving an imeng or a deployment from the first version to the second, and what to do about it: new settings, database migrations to run, behaviour to expect, how to move a game over. Every minor version needs one; the table below lists them. At a major version, consolidate the minors of that major into one `N-to-N+1.md` (see `CONTRIBUTING.md`).
Versions are frozen at 1.3 for now (the public release): changes since the first 1.3 cut live in `1.2-to-1.3.md`, "Added since the first 1.3 cut". Start a new file only when the next release is cut.

| From | To | File |
|---|---|---|
| 1.1 | 1.2 | `1.1-to-1.2.md` |
| 1.2 | 1.3 | `1.2-to-1.3.md` |

`config.json` format migrations (a different thing: the settings file, not the database) live in `src/utils/migrations/`.
