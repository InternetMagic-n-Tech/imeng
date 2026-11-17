# config.json migrations

One file per format change, `vN-to-vM.ts`, listed in `index.ts`. The engine's current format version is `1 + MIGRATIONS.length`.
Only `config.json` is migrated in code. Everything else (`SYSTEM_PROMPT.md`, `HOW_TO_TEST.md`) is described in the migration's `notes`.

## Adding one (engine authors)
1. Copy `TEMPLATE.ts` to `v<N>-to-v<N+1>.ts`; fill `title`, `up`, `down`, `notes`, `rollbackNotes`. Both directions are required. If a rollback loses information, say so in `rollbackNotes`.
2. Append it to `MIGRATIONS` in `index.ts`. Update `src/utils/config-schema.ts` to the new shape, then `npm run schema`.
3. Add tests (up, down, up-then-down gives back the input where the format allows it).
4. Bump the root `package.json` `version` (minor; major if a game must change to keep working), add the README note, and update every shipped game (`game/`, `imengs/*`): `npm run migrate -- <dir> --write`, follow the printed notes, retest, set `proxy_version`.

## Saved sessions
Sessions are stamped with the `schema_version` config.json declared when they were saved (unstamped = 1). A migration may add `session(doc)`: it turns a stored session document of the `from` format into one of the `to` format (pure). A stored session loads after an upgrade only if every step between its stamp and the game's version has one; otherwise `SESSION_SCHEMA` decides (`refuse`, the default, stops the server at startup; `warn`; `off`). There is no way back: a session newer than config.json is refused. Say in `notes` when a migration has no session step (the saves must be cleared).

## Migrating a game
`npm run migrate -- <game dir>` is a dry run: it prints each step's title and notes and the resulting `config.json`. Add `--write` to save it (the old file is kept as `config.json.bak-v<N>`). Then follow the printed notes by hand and run `npm run doctor`.

## Rolling back
1. Stop the server. Keep the game folder's copy of `config.json` and `SYSTEM_PROMPT.md` as they are now (copy the folder).
2. `npm run migrate -- <game dir> --to <N>` (dry run), check the output, then add `--write`. Or restore `config.json.bak-v<N>`.
3. Follow the printed **rollback notes** for the `.md` files; they say what to undo and what the old format cannot hold.
4. Set `schema_version` (the tool does) and the game's `proxy_version` to the proxy version that supports format N; bump the game's `version` (minor; major if saves no longer fit).
5. Rerun the game's `HOW_TO_TEST.md`. Chats started under the newer format keep their saved state; start a new chat if the old game misbehaves.
