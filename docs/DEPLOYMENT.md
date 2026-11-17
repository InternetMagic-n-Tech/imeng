# DEPLOYMENT.md

How the proxy runs in development and in production, where sessions live, and how interfaces plug in.

## Modes
| | start | sessions | models |
|---|---|---|---|
| **ephemeral** (dev) | `npm run start:ephemeral` | memory only; a restart wipes them | the judge is started on the next port when needed |
| **file** (dev, default) | `npm start` | one readable JSON per session in `SAVE_DIR`; restarts keep them | same |
| **production** | `NODE_ENV=production` (or `ENV=production`) with `REDIS_URL` | Redis, shared by every server | the narrator (`UPSTREAM`) and the judge (`JUDGE_URL`, or `judge_instance`'s host and port) are **always on**; this process starts nothing |

Production logs what it assumes and what is missing (no `REDIS_URL`: files, one server only; no `PROXY_API_KEY`: `/v1` is open). It warns; it does not refuse to start. `SESSION_STORE=file|redis` overrides the choice; `--no-persist` always means memory.

## Sessions in Redis (`src/utils/store.ts`)
Three keys per session under `SESSION_PREFIX` (default `imeng:<model_id>`, so games can share a Redis): the document, a version counter and a lock.
- **One turn at a time, across servers.** A turn takes the session's lock (`SET NX PX`, a token, a lease renewed every third of `LOCK_TTL_MS` while the turn runs). A crashed server frees the session when its lease runs out. A turn that cannot get the lock within `LOCK_WAIT_MS` answers "this game is busy" (HTTP 502) and changes nothing.
- **Read the newest copy first, write once at the end.** The turn reads the session from Redis (replacing an older copy in memory), and saves once when it ends.
- **A stale writer cannot overwrite.** Every write states the version it was based on (a Lua compare-and-set). A server whose lease was lost gets refused, drops its copy, and re-reads on the next turn.
- **A table's private notes** from another chat take the table's lock too (always after their own chat's lock, never the other way round).
- Documents and versions expire after `SESSION_TTL_DAYS` (30) of not being written. Sessions are keyed by Open WebUI's chat id, so production needs `ENABLE_FORWARD_USER_INFO_HEADERS=true`.
- Every document carries the `schema_version` of the config.json that wrote it. At startup the server scans the stored documents (up to `SESSION_SCHEMA_SCAN_LIMIT`, 5000) and **refuses to start** when one was written under another version and no migration has a `session` step for the gap (`SESSION_SCHEMA=warn` starts anyway, `off` skips). Fix by writing the migration's session step, or `npm run sessions -- clear`.
- Seats (who sits at which table) are a Redis hash `<SESSION_PREFIX>:seats`.

## Iterating without flushing Redis
Redis keys are per game, so changing one game never touches another. And you can move sessions between Redis and plain files:
```bash
npm run sessions -- list                    # the sessions in Redis (this game, or --game <model_id>)
npm run sessions -- export ./saves/dump     # readable JSON, the same files file mode keeps in SAVE_DIR
npm run sessions -- import ./saves/dump     # load (and edited) files back; replaces a session with the same key
npm run sessions -- clear                   # remove this game's sessions
```
Open an exported file to see exactly what Redis holds, edit it, import it, or point `SAVE_DIR` at the folder and run `npm start` against it. What is **not** built: migrating saved state when `config.json` changes (new fields, renamed fields, new rule texts). Old sessions keep their shape; use `clear` or edit an export for now.

## Keeping the record in step with the conversation (`sync`)
The conversation is the truth; the saved state is a cache derived from it. Open WebUI resends the whole chat every turn, and an interface that has no chat (Discord) builds a transcript, so the two can drift: the saved files were lost, a player edited an earlier message, the proxy missed turns. The engine compares the transcript it is sent with a fingerprint it saved for each turn (`src/utils/sync.ts`). The check is deterministic: no model decides whether the history is intact.
- **Fingerprints:** per completed turn, a hash of the player's message (whitespace and Unicode forms ignored) and a MinHash sketch of the reply, so a lightly edited reply is still recognised and a rewritten one is not (`sync.similarity`, default 0.7).
- **What it finds:** the player went back (regenerate or edit the latest message: the record is rolled back, as it always was); an **earlier message was edited** or a different branch arrived; the transcript has **turns the record never saw**; there is a conversation but **no record**.
- **`sync.mode` in config.json:** `detect` (the default) only keeps fingerprints and the audit log and repairs nothing, so existing games behave as before; `repair` rolls the record back to just before the first differing turn and replays the later turns through the extractor, in batches (`batch`, 4), at most the latest `replay_turns` (10) of them (older turns keep the state before them); `off` does neither. A repaired or rebuilt record is flagged `approximate`, and the narrator is told in plain words (a CATCH-UP block, which now reaches the narrator even when `state_notes` is off).
- **When it cannot be repaired:** if the extractor is not answering, the turns wait in the session's backlog and the turn is played with a note. After three failed attempts in a row the player gets "I can't rebuild this game's record from the conversation right now... try again in a moment; if it keeps failing, start a new chat", and the game recovers as soon as a replay succeeds.
- **Audit log:** each session keeps a bounded log (`audit_keep`, 200) of what was decided and why (turn, kind, a short reason, the fingerprint tip): no message text. It is saved with the session (files and Redis) and the last ten entries show in `/debug/state`.
- **Not covered:** a table (the room's own transcript is the record); an interface that decorates the replies it shows (the fingerprint would differ every turn: leave `sync.mode` on `detect`); a replay is only as good as the extractor reading the text, and hidden facts (a secret never said in the story) cannot be recovered from a transcript.

## Interfaces (`src/modules/`)
`engine.ts` runs a turn and knows nothing about where the message came from. An interface module turns its platform's message into an `Inbound` (identity through `get()`, the chat so far in `body`), gives the engine a `Sink` to answer through (`canned`, `relay`, `passthrough`, `fail`), and lists in `missing` what it cannot do (logged once at start as `[interface <name>] missing feature: ...`, never an error). `INTERFACES=openwebui` (default) mounts the OpenAI-compatible API; add a module under `src/modules/<name>/`, register it in `src/modules/index.ts`, and list it. Two exist: Open WebUI, and **Discord** (`DISCORD.md`): the Discord connection lives in a separate bridge process (`discord-bridge.ts`, many bots, a gitignored `discord.config.mjs`) that talks to the proxy like any OpenAI-compatible client, so the engine is unchanged. The proxy-side module only makes sure the bridge is running (started outside production, assumed in production). An interface may send background for a turn in the `X-Game-Context` header (URL-encoded text, up to 2000 characters): it reaches the narrator as an untrusted CONTEXT block, is never part of the transcript, and so never changes the record's fingerprints.

## Pictures (`images`)

The renderer (ComfyUI, AUTOMATIC1111...) runs on the host like the models, never in the container; set `IMAGE_URL=http://host.docker.internal:8188` for the container. `/images/<name>` is served without the API key (a browser must load it), so put it behind the same TLS reverse proxy and set `PUBLIC_URL` to the public address. Mount `IMAGE_DIR` as a volume if pictures should survive a rebuild. Pictures are never deleted by the engine. See `IMAGES.md`.

## Running the tests
The default suite needs no network, Ollama, Redis or Docker. The Redis tests are in `tests/integration/` and are skipped unless a real Redis is given:
```bash
redis-server --port 6390 --save "" &
REDIS_TEST_URL=redis://127.0.0.1:6390 npm test -- tests/integration
```
They cover the lock (mutual exclusion, lease renewal, a crashed holder, a lost lease), compare-and-set races, expiry, export/import/clear, and the engine continuing a chat after its memory was emptied ("another server").

## Not built yet
Redis Streams between the Discord bridge and the proxy (for messages the proxy starts itself), the docker-compose one-shot (proxy, Redis, MLflow, Open WebUI), MLflow metrics (a run with latency per role, ops accepted and rejected, lock waits), a server-kept transcript for interfaces that send no chat history, image generation and a GPU lease, waiting for a free narrator model, state migration when `config.json` changes. A session grows with every turn (all snapshots are kept for rollback); long games make larger Redis documents.
- **Machine guard:** set `CONTEXT_MAX_TOKENS` (refuse a prompt the model cannot carry: HTTP 413, nothing saved) and optionally `CONTEXT_MAX_ROUNDS` (close the game on that round) to match your hardware; see the env table in docs/OPERATIONS.md. Both are off when unset.

## The database (Postgres) and the version stamp

`DATABASE_URL` (`postgres://...` in Docker, `sqlite:<file>` / `sqlite::memory:` for tests) turns on the bookkeeping database (Kysely). Unset: no database, nothing below applies. The compose file runs it for you: `postgres` (data in `docker/volumes/pgsql`, set `POSTGRES_PASSWORD` in `.env`; also `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PORT`), a one-shot `migrate` service (applies the migrations and writes the version stamp, then the proxy starts) and a `cleanup` service (removes rows past their `expires_at` every `CLEANUP_EVERY_MS`, default one hour). By hand: `npm run db:migrate` (`-- --status` only reports) and `npm run db:cleanup`. Run `db:migrate` again after every upgrade.

**Review the query plans periodically.** A query that was fast with a hundred rows can scan a million. Every few weeks, and after any release that adds a query or an index: in `psql` run `EXPLAIN (ANALYZE, BUFFERS) <query>` on the hot ones (the `player_state`, `eligibility` and `stamp` lookups and the cleanup deletes), look for sequential scans on big tables and for rows estimated far from rows found, and run `ANALYZE`. Turn on `pg_stat_statements` (`shared_preload_libraries`) to see which queries cost the most. The `db` tool (TOOLS.md) can run read-only queries but not `EXPLAIN`; use `psql`. Check that `expires_at` stays indexed, since cleanup depends on it.

**File bucket.** The compose file also runs RustFS (data in `docker/volumes/minio`, set `MINIO_ROOT_PASSWORD`; see docs/OPERATIONS.md, "File bucket"). Back up `docker/volumes/pgsql` and `docker/volumes/minio` together.

**Fail closed.** The database is the source of truth for the version: its applied migrations and its stamp (schema, eligibility rules, game version, proxy version) must match what the running code expects. The stamp is re-read every `STATE_PROBE_MS` (default 5000) and at the start of every game turn. On any difference (database ahead of the code, behind it, or stamped by another version) the instance, in production and in development alike: (1) refuses game turns with a plain "unavailable" reply (`state.texts.unavailable` in config.json), (2) answers `/healthz` with 503 `{ok:false, reason, expected, found}` (it reads a cached verdict and never needs the database to answer), (3) logs the reason and exits with code 1. A supervisor restarts it on the new version. At start it refuses to run against a database that is not migrated. `STATE_EXIT=off` logs the problem and carries on (debugging only). An unreachable database is an ordinary error (logged), not a version failure.

`npm run doctor` has a `migrations` group: reachable, pending, ahead, stamp differences, and the migration a game's HOW_TO_TEST.md records (`Last database migration: <name>`). Doctor and `db:migrate --status` only report; only `db:migrate` changes the database. Not checked: a migration file edited after it ran (Kysely stores no checksum): never edit a shipped migration, add a new one.
