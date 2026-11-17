# DESIGN.md: owners, accounts, stores and schedules

Status: design. Stages 1 (brag wording), 2 (owner, succession, telemetry) and most of 3 (database, stamp, doctor, cleanup, db tools) and 4 (rehydration, eligibility, "since you slept") are built; the rest is not. Everything is off by default, generic (no engine-hard-coded English; texts live in `game.json`), covered by tests with every model, database, Redis, MLflow, Discord and network call faked, and the same in non-persist mode (memory stores instead of Redis and SQL; nothing touches disk). Open points are at the end.

## Stages (in order)
1. "Private cards stay private unless the player or NPC brags". **Built.**
2. Owner, succession, `/telemetry off` (kept in the session store; works without SQL). **Built** (`owner.answers`, not `succession.answers`; fallback `close`|`open`).
3. Kysely, Postgres, migrations, TTL and cleanup, consistency checks, PII tools.
4. Rehydration (SQL to Redis), eligibility flags, "since you slept" notes.
5. Credit, lending, re-entry codes, frozen-NPC safeguards (needs 2, 3 and 4).
6. Private ops: NPC update proposals accepted or rejected by a judge; a player's own ops in a labelled block.
7. Vision judge and model fallback.
8. Discord DM inquiry.
9. Scheduler and market calendars.

## Owner and succession
- The activation message creates the owner (a real user, never an NPC, even frozen). `game.json` `owner` declares it and its succession rules.
- Decided and enforced in TypeScript. There is no transfer path except the succession rules; every succession event is announced to the table. Open WebUI's own chat transfer has no effect here.
- Succession: an ordered list of successors; a claimant answers short challenge questions (for example the date the instance was created). Answers are visible for transparency by game.json enum (`succession.answers`: `hashed` default, or `plain`); everything else about a succession is announced. If the successor also vanishes, the instance asks the series of questions again; the last fallback (close or stay unowned) is a `game.json` enum.
- The owner may add and edit succession rules, `/telemetry off`, and allow the house to lend a player money (debt, with a per-player limit in `game.json`).

## Telemetry
`/telemetry off` (owner only) stops recording for that chat. It never deletes anything already recorded. A top-level env var and a yargs flag turn telemetry off for the whole process; the flag wins.

## Stores
- **Redis**: the live session. **SQL (Postgres via Kysely)**: the bookkeeper for players and accounts: credit, debt, owner, succession, re-entry codes, eligibility, last-run state. Compose service with `docker/volumes/pgsql`. Tests use Kysely's SQLite dialect; the Docker run applies the same migrations to Postgres.
- Rows have an expiry. A cleanup job (a compose service) removes expired rows and stale Redis keys by rule set, including schema mismatches.
- **Versions** are stamped on the schema, the eligibility rules, and the game. If a running session's version differs from the stores, retry with exponential backoff for a time set in `game.json` (it may be mid-update). If it is still mismatched, or memory, Redis and SQL disagree, the instance is stale: log it and `process.exit(0)`. The compose restart policy must restart on exit 0 (`unless-stopped`/`always`).
- Non-persist mode covers every database and Redis path: all in memory, and whatever Discord or Open WebUI deletes is simply gone. A new process ignores earlier prompts and picks up from the state and registration (registration may take several messages).
- Secrets: a small adapter that works 100% locally and offline (env vars, a local secrets file, Docker secrets); a networked vault is an optional extra later. No homemade vault.
- PII: game.json lists fields that are personal (`pii`); tools redact or drop them before they reach SQL, logs or MLflow, and a check fails if a stored path is marked personal.
- A process that finds its own version out of step (for example the semver changed) shuts itself down with exit 0 so the supervisor restarts it.
- Rule: review new queries against the execution plan. GAME-MAKING will say: record the last database migration at authoring, and run HOW_TO_TEST against a fully migrated database.

## Rehydration and "since you slept"
- `game.json` `rehydrate` lists the paths kept in SQL, for example `["actors.*.chips","actors.*.credit","game.variant"]`. Only numbers, booleans, enums and ids (and display names if opted in). Never narration, history, prompts or free text.
- "Last run state" is that subset when the session ended; "current state" is what the stores hold now. On create or revive, the difference is loaded from SQL into Redis (ELT, by last update) and the narrator is told what changed, from `game.json` templates (for example "{name} added enough credit to join the next game"). An external change to Redis or SQL is picked up the same way.

## Eligibility
Named flags in `game.json`, compiled by code to a bitmask, versioned and migrated like the schema; the names are the source of truth.
```json
"eligibility": { "version": 1, "flags": ["paid_up", "opted_in", "last_game_ended", "npc_busted"],
  "join": { "require": ["opted_in", "last_game_ended"], "block": ["npc_busted"] } }
```
Joining needs every `require` flag and no `block` flag. Freezing asks the conditions (does the NPC continue, may it use credit, opt-in for the next game). A player who went NPC and then busted or won always needs to opt in again. A frozen player's NPC never uses credit or debt by default.

## Credit, debt, re-entry
- A busted player gets a code, shown only to them. Once the external service marks it paid (a state change), or they have enough credit and the session rules allow, they can re-enter. A code is single use and expires; the owner or successor is told when one expires (an untracked message).
- Owner-only lend allows debt, up to the `game.json` limit. When everyone stops playing the dealer goes home; someone starts a new game.
- Notifications: Discord DMs ("your credit arrived 5 days ago"). Open WebUI cannot push: a joining user gets a "while you were away" summary of what is pending.

## Private ops
- An NPC (or the narrator) may push a state update to an NPC as one op or an array. The receiving NPC accepts or rejects it through a judge (reads the NPC's description and the rules). A rejection is final: no retry.
- A player may send ops for their own actor in a labelled fenced block (single backticks for one op, triple for several), never touching another actor; which fields are player-writable is game.json.
- Arrays are applied in order. `ops.policy` in game.json: `all_or_nothing` (default: any failure rolls everything back), `stop_at_first_failure` (keep what succeeded before it), `best_effort` (keep the successes). Failures are logged.

## Vision judge and fallback
- With compare models configured, a judge reads `VISION.md` and the prompt summary and decides whether a reply fulfils the vision. A model whose reply fails is treated as broken for that turn: the failure is signalled (log and MLflow tag `main_failed` or `compare_failed`) and the next model answers. The user only ever sees a reply that passed.
- With no model left, the proxy answers with an error status: 502 when replies came back but none passed, 503 when no model was reachable, 500 for an internal fault.

## Discord DM inquiry
A command makes the bot DM a user about a unique id ("ask me about b21xv21"); the reply is added to that user's private notes. The prompt controls the tone: short, consistent, like passing codes, ending quickly.

## Scheduler
Tasks run on a clock: real, virtual (the stock tool's time travel) or game-defined. Examples: the Vibe Trader posts at 8:00, 8:30 and 9:25 ET, on known economic events, and after their results; NYSE and NASDAQ holidays and closures come from a calendar file. Proactive posts work on Discord; Open WebUI shows them at the next message.

## Choices left to the game
Every A-or-B choice is a `game.json` enum with a safe default: the final succession fallback (close or stay unowned), who may start a Discord inquiry (owner, player, narrator tool), whether a frozen player's NPC continues, and which clock a scheduled task uses (real, virtual, or a game-defined clock field, which is what "alternative universe time" means here).

## Decisions of 2026-11-14 (after stage 2)
- Owner answers (`owner.answers`, per question override): `hashed` (default; salted scrypt, per-chat salt, constant-time compare), `plain`, `secret` (expected answer read from the local secrets adapter, never stored in the session). Questions become a `game.json` list `{id, text, source}`; `created` and `name` stay the defaults. Not built yet.
- Announcements: a typed event `{kind, from, to, at}` is stored with the session; each adapter has an `announce(event)` hook and may deliver it its own way and mark it delivered, which skips the in-reply notice. Default stays one reply line plus one table notice, with no duplicate for the claimant. Not built yet.
- Database tools (stage 3):
  1. An AI tool in `tools/` (REGISTRY), `db`: the model asks for data and the tool runs a read-only, parameterised query (Kysely), with a table/column allowlist from `game.json`, row and time limits, PII redaction, and the query plan checked against the execution plan. Off unless `game.json` lists it.
  2. A test tool for the driver (`driver db`): create a fresh database from the migrations (SQLite in tests, Postgres in Docker), run a query, and check the exact outcome (rows equal, count, none). Cases can declare seed rows and assert on rows after the steps, like `state` today.

## Migration doctor and state-failure exit (2026-11-14)
- **Migration doctor** (`npm run doctor` check group `migrations`, and `driver check`): compares the migrations in the code, the ones the database has applied (ids and checksums), and the last migration each game's `HOW_TO_TEST.md`/game folder recorded at authoring. It reports: pending migrations, applied migrations the code does not know (the database is ahead: a newer deployment ran), checksum drift (an applied file was edited), out-of-order ids, a game authored against a newer migration than the database has, and an eligibility-flag or schema version that differs from the stores. `--bail` and `--ignore <id>` work as in the existing doctor. It never applies anything; a separate `migrate` command does.
- **What counts as a failure**: a bad version stamp in memory, Redis or SQL. Each store holds a stamp (schema, eligibility rules, game, proxy version) and the stores are the source of truth: SQL's migrations table when SQL is on (else Redis's stamp), and memory's stamp is the process's own. A failure is any stamp that differs from the code's expected version or from the source of truth. An unreachable store is not a version failure (it is an ordinary error, retried and logged).
- **When it is noticed**: as soon as possible. The stamp (the version and Kysely's migrations table state) is re-read on a short timer (env `STATE_PROBE_MS`) and again at the start of every game turn, so a migration or version change made by another deployment is caught within moments, not on the next restart.
- **What happens (production and not production alike)**: (1) the instance stops serving game turns and answers "unavailable"; (2) `/healthz` returns 503 `{ok:false, reason, expected, found}`; (3) the process logs the reason and exits with code 1. In development that exit is what tells the person at the machine to look into it; in production the supervisor restarts it on the new version. There is no production/development difference and no retry.
- **Health check survives an out-of-sync deploy**: `/healthz` never throws and never needs the failing store to answer; it reads a cached verdict refreshed by a cheap version probe (the stamped schema version, not a query on user data). An old instance whose database is ahead, or a new instance whose database is behind, reports 503 with the reason instead of serving or crashing. Direct (non-game) mode and non-persist mode have no stores to be out of step, so they stay healthy.
- Env vars (can stall or crash a machine): `STATE_PROBE_MS` (the probe interval) and a switch to log-only instead of exit for debugging. Texts are in `game.json`. This supersedes the earlier "retry with backoff, then exit(0)" line under Stores.

## Stage 3 status
Built: Kysely (Postgres / SQLite), migration `001_players`, the stamp and the fail-closed guard, `/healthz` 503, `db:migrate`, `db:cleanup`, compose `postgres` / `migrate` / `cleanup`, doctor group `migrations`, the `db` tool, `driver db`, `pii` masking (`src/utils/pii.ts`). Not built: masking wired into logs and MLflow (no SQL writers exist yet; the pure function and the "stored path may not be personal" check are ready), Redis stamp and stale-key cleanup, the memory/Redis/SQL disagreement check (needs rehydration, stage 4), case-file `db:` seeding, checksum drift, SQLite as a production dependency for `--no-persist` (better-sqlite3 is a devDependency).

## Stage 4 status
Built: migration `002_rehydrate_eligibility` (`player_state`, `eligibility`), `rehydrate` (per-person `actors.*.<field>` values: pulled before a turn, pushed after; outside changes told once from `rehydrate.notes`), `eligibility` (flags, bitmask, version stamped into the `rules` stamp as `1.e<version>`, join gate at a table, `/optin` `/optout`, rules that set flags, mask reset on a version bump by `db:migrate`), doctor group `rehydrate`. Decisions made while building: only per-person paths (`actors.*.x`) for now (game-wide `game.*` values need a session-keyed store); the database wins for listed paths; the "since you slept" lines go to the narrator through the existing catch-up block (not to the player's reply); the join gate applies at a table, not to a solo chat. Not built: game-wide rehydration, the memory/Redis/SQL disagreement check, the freeze questions (stage 5), notifying players of eligibility changes, carrying masks across a version bump.

## PII, second version (plan, 2026-11-15; nothing below is built)
This is a portfolio piece, so the default is the maximum: no model (narrator, extractor, judges), log, trace or database row sees a real-world name or a private value.
- **Classes.** `pii_classes` in game.json is an array of strings. Default: every built-in class (person, pet, password or secret, PIN, age, location such as address, town, employer, and items). A game may narrow the list or add custom classes (a plant would add `equipment_location`). The classes are given to the detector as labels.
- **Detector.** A small local model at the door reads each player message and lists what it finds (names of people and pets, locations, ages, PINs). Code swaps each for a stable token: `[man:3fa9c2]`, `[woman:...]`, `[person:...]` (gender unclear), `[pet:...]`. Names already in the record are caught too. The earlier code patterns (email, phone, card, id number, ip, secret) stay.
- **New-class judge.** A judge notices a kind of private data the list does not name (for example a PIN given while handing over a prop phone). It is masked anyway and a "new class" finding is logged.
- **Restoring for the player.** Names are put back on the way out (the player reads "Jim"; models, logs, traces and state hold tokens only), using a small per-chat lookup table kept in the session store and deleted with the session (TTL cleanup). Secrets (passwords, PINs) are never shown back: both ways they are a placeholder word. `pii.placeholders` sets the wording per class (default `[SECRET]`). The option `pii.restore_secrets` exists, default false, and no shipped app turns it on.
- **Age.** Code reads the real age before masking, keeps it server-side and gives the narrator only "adult" or "minor".
- **No silent failures.** If the detector call fails the message is refused with a retry line and logged as an error. Every miss, failure and new-class finding goes to a local review log (class names, never values).
- **Names (decided).** The narrator never writes a name. A name a player gives at registration for themselves becomes a token like any other. A contestant the narrator would have invented is named by a separate small naming call: `names.prompt` in game.json (a default exists; `{used}` is the list of names already given). The narrator only says tokens; code swaps in the name for the player.

## Where the deck and the world live (open question, 2026-11-15)
Today a card deck is in the state JSON (`table.reserve`, `table.dealt`, `board`, each player's `hole`), and every turn's whole state is saved as a snapshot (Redis or a file). The dungeon holds hp and inventory the same way. Idea: keep what is bulky and mostly hidden (the deck order and where each card is, the dungeon's rooms and monsters) in SQL rows keyed by session and turn (append only, so a rollback deletes the rows after that turn), and keep in the state only what the narrator must see. This shrinks every snapshot and Redis. Open: whether to do it now or after the loops; rollback and regenerate must keep working.

## Dungeon party and the dead (decided, 2026-11-15)
The Dungeon is built for one to six players. A player who dies can still use the private channel; anything they say in the shared chat is ignored by the game (no state change, no reply to it). Deck and world in SQL: the order does not matter to the owner; it comes after the loops.

## File bucket (built, 2026-11-15)
RustFS in docker-compose (service `rustfs`, data in `docker/volumes/minio`), optional `BUCKET_*` settings, `src/utils/bucket.ts` (best effort, never stops a game). Pictures are copied to `images/<name>`. Not yet wired: uploads from players and files the discord bridge sends (no call sites exist for them yet).

## Built 2026-11-15 (later)
- Code moved to `src/` (utils, modules, tools, app, engine); entry files stay at the root.
- Game settings may be `game.mjs`; `driver build` writes game.json from game.mjs.
- Compose: one service per app behind profiles; all data under `docker/volumes/`.

## Uploads, the bucket and MLflow (built for Open WebUI 2026-11-15; Discord still to do)
Attachments Open WebUI or Discord send (an image that did not come from us) are captured at the door: the data URI or the Discord attachment is streamed into the bucket (`uploads/<session>/<id>`), with chunks staged in `_cache/` in the repo root when the stream has to be bridged locally. A new database table (migration 003, `attachments`) records id, session, chat or thread, message, user, sha256, bucket key, mime type, size, source and expiry, so we know which message, thread and session a file belongs to. The model sees a placeholder (`[image:<id>]`), not the file. MLflow gets the file's id as an attribute on the turn's trace; no file bytes and no PII go to MLflow (full capture is scrubbed first).

## Decks, lookup tables and magic users (plan, not built)
- **Lookup tables in game.json.** A `tables` block names tables the engine can read: `{ "power": { "by": "rank", "rows": [ { "match": ["2","3","4"], "value": 0.5 }, { "match": ["5","6","7","8","9","10"], "value": 1 }, { "match": ["J","Q","K"], "value": 1.25 }, { "match": ["A"], "value": 1.5 } ] } }`, and a rule or a calculated field can refer to `table:power[card.rank]`. Doctor checks every row.
- **Decks.** A `decks` block defines a deck (the cards, and optionally a suit meaning). A magic user always draws from the top. A played card disappears from play (the story may say a bird swooped it away) and, once it leaves the hand, goes back into the deck at a random position in the bottom half only, never the top half. No card is ever duplicated. The card's rank sets the power through the table; the suit (cold, hot, earth, water) only says whether the spell fits the one cast: a mismatch is "not very effective", never a failure, and has no number. The deck order and where each card is live in the database (see "Where the deck and the world live"), not in every snapshot.

## Data judge and per-app validators (plan, 2026-11-15; nothing below is built)
Models copy placeholder JSON ("blah-blah-blah", `<field>`, `"..."`) from a prompt, and the operation fails even though it is valid JSON. Two changes:
- **Per-app validators.** An app may ship `validate.mjs` exporting zod schemas for its state and its operations. The engine has a default built from the game schema (that already exists); the app's own replaces or extends it. Every operation is checked against it before it is applied.
- **Data judge.** An operation that is valid JSON but cannot be applied (it fails the validator, or holds a placeholder such as `<field>`, `...` or "blah") is not just dropped: a small judge is shown the operation, the error and the part of the state it points at, and proposes a corrected operation. Code validates the proposal the same way, allows one retry, and applies it only if it passes. The judge model and prompt default to the engine's; `data_judge` in the app's settings can replace them. Every repair and every drop is logged (`proxy:state`) and noted on the MLflow span, without values that are PII.
- **Doctor.** A check that finds JSON in an app's prompts that holds placeholders, with the advice to write real JSON (GAME-MAKING already says so).
- **File name.** The settings file becomes `app.json` / `app.mjs` (the schema `app.schema-v...`), with `game.json` / `game.mjs` still read when there is no app file, since the launch word, the folder and the vocabulary are "app" now. To be confirmed before the rename.

## PII in pictures and MLflow (built 2026-11-15)
The prompt sent to the image renderer and everything a full MLflow capture sends pass through the same scrub as the debug output (emails, phone and card numbers, id numbers, IPs, passwords and tokens, plus the game's own patterns). Names are still to come with the name filter.*.age`); its HOW_TO_TEST has a PII section.

Uploads built: `src/utils/attachments.ts`, migration `003_attachments`, the engine door, `attachment.ids` on the MLflow root span. Still to do: the Discord bridge reading attachments, deleting bucket objects when rows expire, and the vision judge that will let a model describe an image.

## PII classes: relations, roles and animals (plan, 2026-11-15)
- **Person with a relation or a role.** "Uncle Joe is my priest" keeps its meaning but loses the name: the name becomes a token that carries the relation or role stated beside it (`[uncle:3fa9c2]`, `[priest:3fa9c2]`, or `[person:...]` when none is stated), so the narrator still knows who this is to the player and the tone survives. The same name always gives the same token. Relations (family, friends, coworkers) and roles (priest, doctor, boss) are not masked on their own; they identify nobody without the name.
- **Sensitive roles.** A role or fact that reveals religion, health, politics or orientation about a named person is its own class (`sensitive`, on by default in the maximum set): a judge flags it and the whole phrase is masked, not only the name.
- **Animals.** The `pet` class becomes `animal`: named pets and named livestock ("Bessie the cow"). An unnamed "my cow" is not personal data.
- **Validators are functions.** `validate.mjs` exports functions (`validateOp(op, state)` returning ok or an error) as well as zod schemas, so an app can enforce rules a schema cannot say.

## Naming: imeng (open, 2026-11-15)
The project is the Internet Magic Engine (`imeng`) and the things it runs are imengs, not games. Scope to settle before renaming: folder (`apps/` to `imengs/`), launch word (`App:` to `Imeng:`), settings file, env var `GAME_DIR`, package and image names. The state tree's `game` key (game.phase, game.turn) is the engine's fixed state shape and stays.

### Multiples (twins, triplets, litter-mates)
Not a list of words. A relation is a base (`brother`, `sister`, `sibling`, `cousin`...) plus an optional `multiple` qualifier that covers any size: twin, triplet, quadruplet, any "one of N", and litter-mates. The detector returns `multiple: true` (or `n` when stated) and code writes the token as `[brother+multiple:3fa9c2]`; the narrator still gets "this is a sibling born together with the player", and each sibling keeps their own name hash, so two twins never collapse into one person. Animals use the same qualifier (`litter`), so a named litter-mate stays an `animal` token.

### Rename done (2026-11-15)
`apps/` is `imengs/`, the launch word is `Imeng:`, settings files are `config.mjs|ts|json`, `IMENG_PATH` replaces `GAME_DIR` (old name still honoured), Redis prefix is `imeng:<model_id>` (existing `game:*` sessions are not migrated), image and container names are `imeng*`, schema is `imeng.schema.json`, guide is `IMENG-MAKING.md`. The state tree's `game.*` key is unchanged. Not touched: the stray top-level `discord/` copy, `DESIGN.md` history, migration notes (now in `migrations/`).

### Built 2026-11-15
Name layer (`pii_filter.names`, `classes`, `mappings` with judge, `restore`, twins and litter-mates as a `multiple` qualifier), secret placeholders (`[SECRET]`), the literal `<private>` tag fix (a block counts only when closed and not in backticks), MLflow `imeng` tag and bottleneck spans, the "what is this?" intro. Still open: code-owned naming call, new-class judge, data judge and per-app validators, loops and gates, dating show, tone fields, multiplayer Dungeon, lookup tables and decks, deck in SQL, Discord attachments.

### Built: data judge and validators (2026-11-15)
`validate` (a JS file with `validateOp(op, state)`), `repair` and `prompts.repair`, `ApplyResult.rejected`, the one-retry repair in the extractor loop (`ops.repair` span), and the doctor `prompt-json` check. Per-app validators for the shipped imengs (dungeon hp) are not written yet.

### Built: loops and gates (2026-11-15)
Phase `actions`/`allow` (op path gate), `silent` and `interrupt` phases with `game.resume` and `"@return"`, `off_phase` hush gate (solo only; hush and ignore, no "narrate" mode), `multiplayer.silenced_when`. Shipped loops: Backrooms and the multiplayer Dungeon (1 to 6 players, replaces the solo one; `validate.mjs`, VISION, HOW_TO_TEST, DEMO). Not live-tested against a real model. Not built: a judge for silent steps, a judge approving magic, the deck for magic users, per-round gating at a multiplayer table (the off-phase gate is solo only; the path gate applies everywhere).

### Built: tone, roles and the dating-show core (2026-11-15)
`tone_fields`, `role_field` and `field_roles`. `src/utils/dating.ts` holds the rules that must be code: directed attraction 0 to 3 moved one level per check with quoted evidence only (a quoted dislike drops one), minors never above 0, eligibility (single adult still in the show), NPC pointing, the finale match (one mutual pair at 2 or 3), and the show clock costs. It is tested but not yet driven by the engine: still to build are the judge that finds the quoted evidence, discovery and reveal flags, the question and answer gate, the per-contestant LLM calls, pre-rolled ambient changes, relationship status at registration, and the finale vote. `game.attraction` and `game.show_minutes` are already protected paths.

### Built: dating check and question gate (2026-11-15)
`dating` (judge finds quoted evidence, code verifies the quote and applies the ladder; `game.attraction` hidden from the narrator) and `question` (the open-question gate with a two-refusal release). Still to build for the dating show: discovery and reveal flags and the private notes, per-contestant calls, pre-rolled ambient changes, relationship status fixed at registration (the field exists; nothing stops the model changing it yet), the finale vote and pairing wired to the engine, the show clock wired.

### Built: show clock, finale pairing, write-once (2026-11-15)
`show_clock` (fixed minutes per round by phase, warnings, finale at the total), `finaleRound` (pointing read by a judge for real contestants, by code for NPCs; one match; `game.royals`), `write_once`. Still open for the dating show: discovery and reveal flags with private notes, per-contestant calls, pre-rolled ambient changes, the hand-raise vote before the finale, a judge for odd free-form time jumps.

### Built: discovery (2026-11-15)
`src/utils/dating-facts.ts`: private notes per NPC, quote-checked reveals, narrator sees notes only for NPCs in the round, attraction by interest/passion requires a revealed fact. Still open: per-contestant calls, pre-rolled ambient changes, the hand-raise vote, free-form time-jump judge, HOW_TO_TEST rows.

### Built: deck core (2026-11-15)
`src/utils/deck.ts` (pure code, tested, not yet wired to the engine): shuffled 52-card deck, draw from the top skipping cards already held, played cards go back into the bottom half at random, card multipliers (2-4 half, 5-10 full, J-K 1.25, A 1.5), suit alignment changes effectiveness only. Still to do: store the deck per player (SQL later), the `magic` phase using it, and the judge that approves the chosen play.

### Built: bucket files deleted on expiry (2026-11-15)
`cleanExpired` now deletes an expired attachment's bucket object (and any staged copy) before its row; a row whose object could not be deleted stays for the next run. The compose `cleanup` service got the bucket settings. Untested against real MinIO or compose.

### Built: naming call and new-class judge (2026-11-15)
`src/utils/naming.ts` (`chooseName`, `alike`, `nameActors`) and `newClassDetector` in `pii-names.ts` (`other` class, opt-in `new_class_judge`). Both tested with fakes only. Not done: restoring names the narrator writes as tokens for NPCs (NPC names are fictional, so they are written straight into state), and enabling `new_class_judge` in any shipped app.

### Built: time-jump judge (2026-11-15)
`show_clock.judge`/`jump_max` (`src/utils/show-clock.ts`). Known gap: a game's narrator names NPC contestants itself in the same reply that introduces them, because the `naming` call runs after the reply; so for now `naming` only fills in names the narrator left empty. Making the narrator leave names to the code needs a placeholder-and-restore step for NPC names, not built.

Update: the naming gap above is closed by a reserved name pool (`naming.pool`, default 3): the server draws names ahead of time and tells the narrator to use them in order for any new character, so no restore step is needed. Untested with a real narrator: whether it obeys the list.

### Built: per-character voices (2026-11-15)
`src/utils/voices.ts` (`voices` block). Open: whether a real narrator uses the lines faithfully, the extra latency with four calls in parallel on one GPU, and a separate model for voices (the `judge` override exists in code but is not exposed in the schema).

### Built: magic-play judge and lookup table (2026-11-15)
`src/utils/ruling.ts` (`ruling` block; the Dungeon, solo only). Open: spell effects as data (damage dice, ranges) rather than words, per-player hands, and a class list for more than three classes.

### Built: hands, NPC relationship status, pot check (2026-11-15)
`deck.hand` (per-player hands, card parsing, play and replace; the Dungeon uses 3), `dating.npc_status` (rolled once, locked). Open: private hands at a table (shown in the shared chat today), rewinding the deck on regenerate, suit alignment per class or spell.

Update: the deck now rolls back on regenerate/edit (`deckAt`), and suit alignment exists (`ruling.suits`, Dungeon map is a guess). Open: private hands at a table.
