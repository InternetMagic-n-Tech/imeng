# Principles and how we work

For people who change the code or make games. It says what the project protects, why, and how a change gets made. `README.md` and `CONFIGURATION.md` say how to use the project; `IMENG-MAKING.md` says how to make a game; this file says what must not break while you do either.

## What this is

A proxy between Open WebUI and a local model server (Ollama). The server owns the game state; the model only narrates. A game is a folder: `SYSTEM_PROMPT.md`, `imeng.json` (or `config.json`) and `package.json`.

The goal is a **low bar of entry**. A small, low-parameter local model should still give a memorable experience, because the server holds the state and the rules and the model only narrates. Everything stays on the local machine. When a design needs a big model to work, move the work into code, or into a smaller, narrower model call.

## The three rules

### 1. The engine stays generic

Game rules, stats, tone and wording live in the game folder, never in `src/utils/`. No hard-coded genre, stat name or English-only text in the engine code (matching is Unicode-aware; `tests/fixtures/custom`, a Spanish game, is the regression).

- New behaviour is a setting in the game's config. The default keeps today's behaviour, and the setting is documented in the docs/CONFIGURATION.md config table.
- Fixed by design: the state shape (`game` + `actors`), the three `controlled_by` roles (`user`, `npc`, `other_player`), and **one game per process**. Several games means several instances, with no shared mutable module config. `npm run hub` is a router in front of such instances; it loads no game itself.
- Prompts, comments and examples inside `src/utils/` use `<field>`-style placeholders, not game words.

### 2. State lives outside the model

Models (narrator, extractor, judges, compactor) produce text or proposals. Code validates and applies them.

Enforced in code, and to be kept that way:

- the turn counter, `exited_game`, `rules` and `controlled_by`;
- operations only on actor *fields*, on paths under `game` or `actors`, as small plain JSON, at most 50 operations per answer;
- `current_actor` is null or a real actor;
- `writable_fields`, `limits`, `max_step` and `exit_when`;
- server-side dice;
- a snapshot per turn, and rollback;
- session keys;
- rule lifting needs evidence and consecutive confirmations;
- setup evidence must be an exact quote;
- wrap-up and compaction are decided by the server.

Every model prompt carries the untrusted-data notice (`UNTRUSTED_NOTICE`) and wraps player text, narration, recorded state and recaps in escaped markers (`src/utils/text.ts`). A prompt override cannot drop the notice.

For any new feature, ask: *could model output change this directly?* If yes, route it through a validated operation or a code check. Never describe the state as tamper-proof: its content is still derived from model output. Bound it with `limits`, `max_step`, `writable_fields` and locked rules.

### 3. AI stays on your machine

Models run on the host's GPU or CPU, never in the image, the compose file or the cloud. The only outbound connections are:

- the narrator (`UPSTREAM`);
- the judge Ollama (`judge_instance` or `JUDGE_URL`);
- `REDIS_URL`;
- the hub to its own game processes (`127.0.0.1` only);
- when a game sets `images`: a renderer on the host (`IMAGE_URL`: ComfyUI, AUTOMATIC1111 or a local image server; see `IMAGES.md`), and a reference URL, fetched only when the game sets `images.reference.urls` (public addresses only unless `IMAGE_REF_ALLOW_PRIVATE`).

No telemetry, no update checks, no hosted APIs. The judge is a small model on its own CPU-only Ollama (`npm run judge` under Docker, reachable only on the Docker bridge address). The Redis log holds full prompts, so treat it as sensitive. Chats in direct mode are never saved or logged.

## How checks are layered

A small judge model alone rubber-stamps, so never make it the only check.

1. **Code rejects what it can verify:** ids, limits, quotes, names, fields.
2. **A model only reads or proposes:** extractor, audit, "what does this recap say". It writes its reasoning before any boolean.
3. **A second, separate model call confirms any accusation.**
4. **A miss is bounded** by `limits` and the rule text, never trusted blindly.

Calls that are not narration send `reasoning_effort: "none"` and a token cap (the judge uses the native API with `think: false`). Keep that for any new call: thinking models can hide-think for minutes.

## Making a change

**Read first.** Read every `.md` in each folder you will touch, and the root ones that govern it. For a game folder that is `VISION.md`, `HOW_TO_TEST.md`, `SYSTEM_PROMPT.md` and `imeng.json`. Before changing an existing game, read "Changing an existing game" in `IMENG-MAKING.md` and the relevant file in `migrations/`.

**A game folder** always has `VISION.md` and `HOW_TO_TEST.md`; a game without both is not finished. Change a game's behaviour, and update both in the same change. Run `npm run check:games` before you finish.

**A change is done when:**

1. `npm run typecheck` is clean.
2. `npm run test:coverage` passes (85% statements, lines and functions; 75% branches). New behaviour has tests, including failure paths.
3. For anything involving processes, signals, Docker or hardware: you ran it for real and measured, not estimated.
4. The README is updated (and this file, if a rule changed).
5. Everything you started is stopped, and models you loaded are unloaded.
6. If you changed engine code (`src/utils/`, `app.ts`, `imeng.json` keys or defaults), `IMENG-MAKING.md` is still true.
7. If a `HOW_TO_TEST.md` sits in a directory you changed, it matches your change: update its steps and cases and prune the dead ones.

**Versions** are managed by the maintainers. Do not bump the root `version` or a `proxy_version` in a change, and do not add new version notes or schema files. Add changes to `migrations/1.2-to-1.3.md` under "Added since the first 1.3 cut" and to `IMENG-MAKING.md`. Shipped games keep `proxy_version` equal to the root `version` (a test enforces it). Every game folder has a `package.json` with its `version` and the `models` it was tested with (narrator and judge: name and digest); update `models` when you test with different ones.

## Code standards

- Typed helpers and small files. Check `wc -l`: consider a split past 500 lines, split past 1000, and say why in a header comment when a file cannot be split.
- No English hard-coded in the engine.
- Every model, Redis, MLflow and network call is faked in tests.
- `console.log` timings around heavy calls.
- Anything that could crash the machine sits behind an environment variable (see `DRIVER.md`, "Machine load").
- **Database:** review every new query against its execution plan (`EXPLAIN`; `driver db` builds a throwaway database for it): no unindexed scans on a growing table, no unbounded reads. Migrations are files (`migrations/NNN_name.mjs` for the engine, `imengs/<game>/migrations/` for one game), each with `up` and `down`. Never edit a migration that has shipped; add a new one and update the "Last database migration" line in each affected game's `HOW_TO_TEST.md`.
- Node is pinned to 22 LTS (`>=22.9.0 <23`).
- **Exit handling** (`src/utils/shutdown.ts`): `onKill` is a synchronous stop of whatever you spawned and runs on every signal; `onShutdown` is async cleanup for keyboard exits only. For other signals, kill what you started and re-raise at once, with no awaiting or logging.
- The project does not change your Ollama service or its settings. The doctor (`npm run doctor`) only reports, for example an Ollama listening on every interface.
- `src/utils/spawn-helper.cjs` is hand-maintained; its types are in `.d.cts`.

## Testing

| Step | Command |
|---|---|
| Types | `npm run typecheck` |
| Unit tests (jest, `tests/fake-ollama.ts`, `tests/fixtures/*`: scripted models, no GPU) | `npm test` |
| Coverage gate | `npm run test:coverage` |
| Live test with real models | the game's `imengs/<game>/HOW_TO_TEST.md` (scripted player, throwaway copy of the game in `/tmp`), or `npm run live` for a table |

- Jest runs as ESM (`--experimental-vm-modules`). Use one fixture folder per config in `tests/fixtures/`. Set `process.env.IMENG_PATH` before importing code. Mock ESM modules with `jest.unstable_mockModule` and a dynamic `import()`. Imports run after `describe` bodies, so build state inside tests. Clear console spies in `beforeEach`.
- `makeOllama()` scripts every model call by prompt text. Add a `kind` when you add a prompt.
- **Live tests** use their own port (the recipes use 3010 to 3012; never one already in use), a temporary copy of the game, and outputs under `/tmp`.
- **One at a time:** test one narrator model and one proxy at a time. They share the GPU and the judge on 11435. If a port you need is taken, someone else is testing: wait, do not start a second server on another port.
- **Clean up:** kill by PID (`pkill -f` can kill your own shell), `ollama stop` the models you loaded, and check the ports are free.

Default ports: proxy 3001 (the compose games use 3001 to 3007), Redis 16379, Redis Commander 18081, Postgres 15432, RustFS 19000 and 19001, judge Ollama 11435, narrator Ollama 11434. Everything binds to localhost unless `PROXY_BIND` says otherwise.

## Gotchas

- The environment file (`.env`) is loaded by `dotenv` and `dotenv-expand` at the start of each entry point (`src/utils/env-boot.ts`). It is never baked into the image: container variables come only from `docker-compose.yml`.
- New root entry files (`server.ts`, `hub.ts`, `judge-host.ts`) must be added to `vite.config.ts` and `COPY`'d in the Dockerfile's build stage. The image copies `./imengs`.
- Compose 2.3.x: after a rebuild, use `docker compose up -d --force-recreate proxy`.
- Express 5's `app.listen` passes the error to its callback, so handle it (`src/utils/bootstrap.ts`).
- PID 1 cannot kill itself by re-raising a signal. Compose uses `init: true`, and `reRaise` has an exit-code fallback.
- `isolatedModules` for ts-jest is set in `tsconfig.json` (not the deprecated ts-jest option).

## Where to read next

`README.md` (start here) · `CONFIGURATION.md` (settings) · `OPERATIONS.md` (running, Docker, env vars) · `ARCHITECTURE.md` · `IMENG-MAKING.md` (making a game) · `DEPLOYMENT.md` (Docker, database, bucket) · `MULTIPLAYER.md` · `DISCORD.md` · `TOOLS.md` · `IMAGES.md` · `DRIVER.md` (the test driver) · `DESIGN.md` (design history).
