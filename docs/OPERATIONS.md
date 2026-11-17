# Running and operating imeng

## Running several games

One process runs one game (its `IMENG_PATH`): state, saved sessions, rules, the judge settings and the model name in Open WebUI all belong to that game, and keeping them in separate processes keeps them from touching each other. To offer several games, run several instances and add each as its own connection in Open WebUI (each shows up under its `model_id`):

```bash
PORT=3001 IMENG_PATH=imengs/dungeon-game SAVE_DIR=saves/dungeon    node dist/server.js
PORT=3002 IMENG_PATH=imengs/lighthouse SAVE_DIR=saves/lighthouse node dist/server.js
```

Give each its own `PORT` and `SAVE_DIR`. They can share Redis (every log entry has a `game` field, the game's `model_id`) and the judge's Ollama (the second instance simply reuses the one already listening on its port). With Docker, add one more service to `docker-compose.yml` using the same image, a different `PORT`, a different mounted game folder (`IMENG_PATH`) and its own `./docker/volumes/<name>:/data`. I ran two games side by side to check this.

**One port for every game: the hub (`npm run hub`).** It scans `imengs/` (any depth, every folder with a `model_id`), starts each game as its own hidden process on a loopback port, and serves one OpenAI-compatible endpoint: `GET /v1/models` lists every game, `POST /v1/chat/completions` goes to the game that owns the `model`, streaming and the `x-openwebui-*` headers pass through untouched. Add one Open WebUI connection (`http://host.docker.internal:3001/v1`) and every game is in the dropdown. Each game keeps its own process, state and saves (`SAVE_DIR/<game folder>`, `imengs/lighthouse` is `lighthouse`); the hub starts them one after another and stops them when it exits. A game that does not start (for example a game whose tool needs `DATABASE_URL`) is named in the log and left out; the others carry on.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `PROXY_BIND` | 3001 / `127.0.0.1` | the hub's address (`172.17.0.1` for an Open WebUI in Docker) |
| `PROXY_API_KEY` | none | the key callers must send; the games behind it accept only a random secret the hub made at start |
| `IMENGS_ROOT` | `./imengs` | where to look for games |
| `SAVE_DIR` | `./saves` | the base for each game's saves |
| `HUB_SKIP` | none | model ids to leave out, comma separated |
| `HUB_CHILD_TIMEOUT_MS` | 90000 | how long to wait for each game to answer `/healthz` |

Flags after `--` go to every game; `npm run hub:ephemeral` is `hub` with `--no-persist` (memory only, like `start:ephemeral`). The hub reads `.env` once and gives its environment to the games, which do not read it again. Not routed (talk to a game directly if you need them): `/api/*` (the Ollama facade), `/admin/*`, `/images/*`. `/healthz` is 200 while at least one game is up. A game that stops later answers 503 until the hub is restarted.

**Several games with docker compose.** Each shipped game is a compose service behind a profile, on its own port (`PORT_<GAME>` in `.env` changes one):

| Profile | Host port | Model id |
|---|---|---|
| `dungeon` | 3002 | `dungeon-adventure` |
| `lighthouse` | 3003 | `lighthouse-game` |
| `backrooms` | 3006 | `backrooms-game` |

3008 is the plain `proxy` service (the game in `PROXY_GAME_DIR`, `PROXY_PORT` changes it); the other ports are free for your own games. Do not run the plain `proxy` and a profile on the same port: if `.env` sets `PROXY_PORT=3001`, remove it before starting a profile.

```bash
docker compose build proxy      # once; the app services use the same image
PROXY_BIND=172.17.0.1 docker compose --profile lighthouse --profile dungeon up -d
```

`PROXY_BIND` matters: the default (`127.0.0.1`) is unreachable from an Open WebUI that runs in Docker (tested: connection refused); the Docker bridge address works, as for `npm start`. Bind to the bridge only, never `0.0.0.0` without `PROXY_API_KEY`.

In Open WebUI (running in Docker) add one connection per game: Admin Panel > Settings > Connections > "+" > OpenAI, URL `http://host.docker.internal:<port>/v1` (e.g. `:3001`), any key unless `PROXY_API_KEY` is set. The models of all connections appear together in the picker. Set `ENABLE_FORWARD_USER_INFO_HEADERS=true` on Open WebUI so each person and chat is told apart. In a single chat a game is just a model: it starts when the first message carries the game's trigger phrase (`invocation`, e.g. `Imeng: Lighthouse`) and passes through otherwise. A table of several people is a chat shared with **Allow replies**; Open WebUI channels do not send a chat id (see `docs/MULTIPLAYER.md`).

## Multiplayer

Several people can play one game through Open WebUI's own group chat. A **table** is a chat shared with **Allow replies** (or a channel): Open WebUI decides who may write in it and shows everyone every message; the proxy adds the game. Each request carries the sender's own `X-OpenWebUI-User-Id` and the shared chat's `X-OpenWebUI-Chat-Id`, so one table is one session and each speaker is known by user id. It needs `ENABLE_FORWARD_USER_INFO_HEADERS=true` in Open WebUI and `"multiplayer": {"enabled": true}` in `config.json`; it is **off by default**.

- **Turn policies:** `ready` (collect what everybody says, narrate when all said "ready"), `free` (every message is a round), `token` (only the holder of a game field acts) and `judged` (the judge model applies a rule you write in words). `order` sequences the lines of a round: `fifo`, `filo`, `join`, `random` or by an actor field.
- **While the table waits:** a terse status line, or with `tension.mode: "beats"` one short narrator line that keeps the waiting player's declared action in suspension. Both are options.
- **Private chats (AD&D style):** a seated person's new chat with the game is a private channel to the narrator: notes go in with the next round and the table never sees them. `private.reply` is `ack`, `narrator` or `none`.
- **Stepping away and giving up:** "I need a break" steps a player away with no reason kept; the game stops waiting and tells the narrator how long they were gone, in real time and on the game's `clock`. A standing instruction ("if I don't answer in 5 days, assume I figure it out") or the game's `default_after` lets the table go on.
- **Seats** (who sits at which table) are kept in memory, in `SAVE_DIR/seats.json` and, with `REDIS_URL`, in the Redis hash `game:seats`.

`docs/MULTIPLAYER.md` has the setup, every key, the details and the known gaps; `imengs/dungeon-game` is the worked example.

## Session rules

Standing rules that shape the story and can be switched off when events justify it.

```json
"session_rules": [
  { "id": "charity", "text": "All proceeds go to charity.", "locked": true },
  { "id": "fog", "text": "Dense fog keeps everyone on the island.",
    "lift_hint": "Lift only if the cause of the fog is resolved or a way off is found." }
]
```

- `locked: true` rules are never lifted.
- `lift_hint` is an optional designer note shown to the judge.
- Active rules appear in the narrator's prompt as "SESSION RULES IN EFFECT".

### The judge

After each state sync, one call to the judge model reviews all unlocked, active rules. The prompt is generic. It says to lift a rule only when recorded events clearly and substantially remove the reason it exists, and that when unsure it should not lift.

What the judge sees: a trimmed **judge view** of the state (who is in play, their recent history, the recent plot events, who has left), not HP, gold or inventory, plus the latest exchange (narration capped at 1000 characters). All judge prompts ask for terse output (evidence up to 20 words, reason up to 12), and each call has an output token cap, which keeps the small model fast and on topic. The setup analysis likewise only sees recorded names, descriptions, relationships and rules.

Guards in code:
- The verdict must include non-empty **evidence**.
- It must say "lift" on `judge_confirmations` consecutive turns. Any "no" resets the count.
- Votes and lifts live in the snapshotted state, so rolling back a turn restores them.

When a rule lifts, the narrator is told on the next turn to acknowledge the change in the story, and the lift is recorded in `game.events`.

The judge uses Ollama's native `/api/chat` so it can set `num_ctx` and override stop tokens baked into a model's Modelfile. The jev model ships with `num_ctx 2048` and stops on `"\n"` and `")"`, which would truncate the prompt and the JSON.

### Dedicated judge instance

```json
"judge_instance": { "port": 11435, "num_ctx": 8192, "gpu": false,
                    "models_dir": "<where your Ollama keeps its models>" }
```

The server spawns a separate `ollama serve` through `spawn-helper.cjs`, waits for it, warms the judge model, reuses it if already running, and kills it on exit. Set `JUDGE_INSTANCE=off` to disable.

Measured on one 24 GB consumer GPU with a 26B narrator:
- **GPU instance: don't.** The two Ollama processes don't coordinate VRAM, so both ended up partly on CPU and first-token time went to 11-15s.
- **CPU instance: works.** The narrator's first token took about 0.4s and the judge takes about 7s warm. `gpu: false` sets both `CUDA_VISIBLE_DEVICES=-1` and `OLLAMA_VULKAN=0`, because Vulkan can still reach the GPU otherwise.

## Running in Docker

**Docker holds the runtime; the models stay on the host.** The container is just the Node proxy (so it can still be built and run years from now). Ollama and the judge run on the host machine, where they get the real GPU/CPU performance, and the container reaches them over the Docker bridge (`host.docker.internal`).

**Which game runs.** The image contains every folder in `imengs/`. The container picks one with `PROXY_GAME_DIR` (compose) or `IMENG_PATH` (plain `docker run`), and **defaults to `imengs/lighthouse`**:

```bash
PROXY_GAME_DIR=imengs/lighthouse docker compose up -d --force-recreate proxy
```

Every app also has its own compose service behind a profile (`docker compose --profile lighthouse up -d`; profiles `dungeon`, `lighthouse`, `backrooms`, see "Running several games"; or run every game behind one port with the hub above); build the image first with `docker compose build proxy`. All data (Postgres, MinIO, Redis, saves) lives under `docker/volumes/`: one folder to copy or show. One game per container (see "Running several games"); saves go in `/data/saves/<game folder>` so two games never read each other's sessions. A `IMENG_PATH` that does not exist stops the container with an error instead of quietly running a default game. Add your own game by putting its folder under `imengs/` and rebuilding the image.

`docker-compose.yml` runs the proxy together with Redis and Redis Commander:

```bash
npm run judge                   # on the host: start the CPU judge Ollama (leave it running)
docker compose build --pull     # --pull picks up the latest patch release of the pinned Node line
docker compose up -d            # proxy + Redis + Commander
docker compose stop proxy       # e.g. to run `npm start` locally on the same port
```

```
 Docker                                   Host
 ┌──────────────┐   host.docker.internal  ┌──────────────────────────────┐
 │ proxy :3001  │ ───────────────────────►│ Ollama :11434  (narrator)    │
 │              │ ───────────────────────►│ judge  :11435  (npm run judge)│
 └──────┬───────┘                         └──────────────────────────────┘
        └──► redis (compose network)
```

| Service | Port (localhost only by default) | Notes |
|---|---|---|
| `proxy` | `3001` | The game proxy. Point Open WebUI at `http://localhost:3001/v1`. |
| `redis` | `16379` | Password-protected, append-only persistence in `./docker/volumes/redis`. |
| `redis-commander` | `18081` | Web UI for the Redis host. Log in with `COMMANDER_USER` / `COMMANDER_PASSWORD`. |

**Node version.** The image is built `FROM node:22-alpine` (build arg `NODE_VERSION`, default `22`), the oldest LTS line still in support, so it never changes with the Node on your machine. The tag follows the newest 22.x patch at build time: rebuild with `--pull` after a Node security release, or pin a digest for fully reproducible builds.

**What the proxy container does:**
- Talks to the narrator's Ollama on the **host** (`host.docker.internal:11434`, override with `PROXY_UPSTREAM`), to the judge's Ollama on the host (`host.docker.internal:11435`, override with `PROXY_JUDGE_URL`), and to Redis over the compose network, so `REDIS_URL` here is `redis://:<password>@redis:6379`, not the `127.0.0.1` one in `.env`.
- Runs as the non-root `node` user (uid/gid from `REDIS_UID`/`REDIS_GID`, default 1000), with a **read-only root filesystem**, all Linux capabilities dropped, `no-new-privileges`, a process limit (200), a 512 MB memory limit and rotated logs.
- Writes only to `/data` (saved sessions and the fallback log), mounted from `./docker/volumes/proxy`.
- Has no `.env` inside (`.dockerignore` keeps it and other local state out of the build context). It receives only the variables listed in the compose file.
- Reports health at `GET /healthz` (no key needed) and Docker restarts it if that fails.
- Sets `ENABLE_DEBUG=0` (no `/debug/state`) and `JUDGE_INSTANCE=off`: the image has no `ollama` binary and never spawns one. It uses the host judge through `JUDGE_URL` instead.

**Signals and PID 1.** Compose runs the proxy with `init: true`, so Docker's bundled tini is PID 1 and Node is its child. tini forwards `docker stop`'s `SIGTERM` to Node and reaps zombies, and the container then exits **143** (128 + SIGTERM) in about 0.25s. Node can also run as PID 1 without an init: the kernel ignores a signal PID 1 sends itself unless it has a handler, so the re-raise in `src/utils/shutdown.ts` can't kill it, and the 128+signal exit-code fallback ends it instead (also 143 in testing). Keep `init: true` (or `docker run --init`) anyway; it is the conventional, more robust setup.

**After rebuilding the image,** recreate the container: `docker compose up -d --force-recreate proxy`. This Compose version (2.3.x) restarts an existing container rather than recreating it when only the image changed, so you would keep running the old code.

**The host judge (`npm run judge`).** It starts the same dedicated CPU `ollama serve` the proxy spawns in local mode (settings from `judge_instance` in `config.json`), but on the host and listening on the **Docker bridge address only** (found with `docker network inspect bridge`, usually `172.17.0.1`). Containers reach it as `host.docker.internal`; your LAN and the wider internet cannot. Override the address with `JUDGE_BIND` (`127.0.0.1`, or `0.0.0.0` to listen everywhere, which exposes an unauthenticated Ollama, so don't). If a judge is already answering on that port it just says so and exits. Without it running, the proxy still starts and an exact trigger message still begins the game, but fuzzy first messages are treated as plain chat (the invocation check fails twice and falls back to direct mode), and setup analysis and rule lifting are skipped. Start the judge first.

**Tunnels.** Anything that makes the host ports reachable works, because the container only needs two URLs: `PROXY_UPSTREAM` (narrator, an OpenAI-style `/v1` URL) and `PROXY_JUDGE_URL` (judge, native Ollama base URL). To use a GPU box elsewhere, forward its ports to the host, e.g. `ssh -N -L 172.17.0.1:11434:localhost:11434 -L 172.17.0.1:11435:localhost:11435 gpu-box`, and the compose defaults work unchanged.

**Before exposing it to the internet:**
1. Set `PROXY_API_KEY` in `.env` (any long random string). Every `/v1` request then needs `Authorization: Bearer <key>`; put the same key in Open WebUI's connection settings.
2. Put a TLS-terminating reverse proxy (nginx, Caddy, Traefik) in front, then set `PROXY_BIND=0.0.0.0`. The proxy itself speaks plain HTTP and is bound to `127.0.0.1` by default.
3. Keep Redis and Commander on localhost, and change `COMMANDER_PASSWORD` if it has ever been shared.

The proxy does **no rate limiting**; anyone with the key can use your GPU. Add limits at the reverse proxy if the key might leak.

### Redis and Redis Commander

Compose reads `./.env` for the `${VARS}` (`REDIS_PORT`, `REDIS_COMMANDER_PORT`, `REDIS_PASSWORD`, `REDIS_UID`/`REDIS_GID`, `COMMANDER_USER`, `COMMANDER_PASSWORD`). The same file holds `REDIS_URL`, which the proxy uses (every entry point loads `.env` at start through `dotenv` + `dotenv-expand`: `$VAR`, `${VAR}` and `${VAR:-default}` expand, e.g. `DATABASE_URL=postgres://proxy:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/proxy`; variables already set in the shell win; a Node `--env-file` flag on the command line replaces this loader, for example `--env-file-if-exists=/dev/null` for a run without `.env`). The services get only the variables they need, not the whole `.env`. `REDIS_UID`/`REDIS_GID` keep the data folder owned by you.

```bash
docker compose up -d      # start
docker compose down       # stop (data stays in docker/volumes/redis and docker/volumes/proxy)
```

## File bucket (RustFS / S3)

Optional. Pictures the proxy makes (and files that are uploaded or sent) are copied to an S3-compatible bucket, so they outlive the container and can be browsed. Off unless `BUCKET_ENDPOINT` is set; docker-compose runs RustFS (service `rustfs`) and sets it for you (data in `docker/volumes/minio`, console on `127.0.0.1:19001`, set `MINIO_ROOT_PASSWORD` in `.env`). The proxy creates its bucket (`BUCKET_NAME`, default `proxy-files`) when it starts.

| Variable | Default | Meaning |
|---|---|---|
| `BUCKET_ENDPOINT` | off | e.g. `http://rustfs:9000` (any S3: RustFS, MinIO, AWS) |
| `BUCKET_NAME` | `proxy-files` | the bucket; use one of its own (an MLflow artifact bucket on the same S3 server is fine, but a different bucket) |
| `BUCKET_ACCESS_KEY` / `BUCKET_SECRET_KEY` | none | credentials (compose passes `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) |
| `BUCKET_REGION` | `us-east-1` | |

**Uploads.** A picture someone attaches to a message (that we did not make) is kept when there is a bucket or a database: staged in `_cache/` (`ATTACH_CACHE_DIR`), piped into the bucket as `uploads/<session>/<id>`, and recorded in the `attachments` table (session, user, turn, message, source, size, hash, expiry `ATTACH_TTL_DAYS` default 30). The models, logs and traces see `[image:<id>]`, never the file, and the MLflow trace notes the ids (`attachment.ids`). The id is the file's hash, so Open WebUI resending the history stores nothing twice. `ATTACH_CAPTURE=off` turns it off; `ATTACH_MAX_BYTES` (default 15 MB) refuses bigger files. If the bucket is down the file stays in `_cache/` and the row says so. Expired rows are removed by `db:cleanup`; the bucket objects are not yet (set a lifecycle rule on the bucket). Discord attachments are not read yet (the bridge ignores them).

A bucket that is down never stops a game: a failed copy is logged (`DEBUG=proxy:bucket`) and the local file is still used. Keys: `images/<name>` for pictures.

## Debug output (`debug` package)

The proxy uses the npm [`debug`](https://www.npmjs.com/package/debug) package for developer logging. It is silent unless the `DEBUG` environment variable names what you want, and it writes to stderr. Names live under `proxy:`:

| Namespace | What it prints |
|---|---|
| `proxy:boot` | each startup step, then "listening on <port>" (the last line tells you how far it got) |
| `proxy:process` | start, uncaught exceptions with stack, unhandled rejections, warnings, exit code, and a memory line every 30 s (`DEBUG_HEARTBEAT_MS`) |
| `proxy:http` | each request in and out with status and time; `!!` marks one cut off early |
| `proxy:redis` | connect and errors |
| `proxy:session` | each session save |
| `proxy:bucket` | each file put into or read from the bucket, and failures |
| `proxy:engine` | each turn: number, mode, phase |
| `proxy:phases` | phase moves and refused moves |
| `proxy:crossings` | each crossing: where to, the ambient, any ad break, what changed |
| `proxy:pii` | what the PII filter found and did (kinds and counts, never the values) |
| `proxy:db` | the state-version check |
| `proxy:rehydrate` | database pulls and pushes with timing |
| `proxy:owner` | owner, successor, claim and telemetry commands |
| `proxy:judge` | each judge call |
| `proxy:upstream` | each narrator completion |

```
DEBUG=proxy:* npm start                       # everything
DEBUG=proxy:phases,proxy:crossings npm start  # only those
DEBUG='proxy:*,-proxy:upstream' npm start     # everything except upstream
DEBUG=proxy:* DEBUG_COLORS=0 npm start 2> debug.log
DEBUG_FILE=debug.log npm start                # also appends every line to a file as it happens, so a crash leaves a trail; turns on proxy:* if DEBUG is unset
```

**After a crash:** `tail -50 debug.log`. The last `proxy:boot` line shows how far startup got, `proxy:process` shows the exception or exit code and the memory just before it (a steadily rising `rss` and no exception usually means the machine ran out of memory), and the last `proxy:http` / `proxy:upstream` lines show what the proxy was waiting for.

**Debug output never holds personal details.** Everything passes through the PII scrub before it is written: emails, phone and card numbers, id numbers, IPs, passwords and tokens (always on, whatever the game's `pii_filter` says) plus the game's own `pii_filter.patterns`. Names are not yet scrubbed (see docs/DESIGN.md "PII, second version"), so keep real names out of what you type while debugging. To add a line, `import { dbg } from "./debug.js"` and call `dbg("phases")("moved %s", x)`; new namespaces go in `NAMESPACES` in `src/utils/debug.ts`.

## Traceability: model response log

Every model call **in a game-mode chat** is logged: the narrator, the state extractor, the judge (invocation, setup analysis, rule judge) and Open WebUI's background requests (title/tag generation) for known game chats. Direct-mode chats are never logged. The invocation check's entry is held until the mode is known, then kept (game) or discarded (direct).

Each entry goes to the Redis stream `game:model-responses` as a **single field, `entry`, holding JSON** (Redis Commander only displays the first field of a stream entry, so one field is what makes it readable there). The JSON has:

| Field | Meaning |
|---|---|
| `ts` | ISO timestamp |
| `game` | The game's `model_id` (so several games can share one stream) |
| `role` | `narrator`, `extractor`, `invocation`, `setup_analysis`, `rule_judge`, `background` |
| `model` | Model that answered |
| `session`, `turn`, `mode` | Which chat, which turn, game or direct |
| `ms` | Duration |
| `prompt` | The messages sent (capped at 20000 chars) |
| `response` | The raw response |
| `error` | Error text, if any |

Browse it in Redis Commander (`http://localhost:18081`, key `game:model-responses`) or with `redis-cli XRANGE game:model-responses - +`. The stream is trimmed to about 100000 entries.

If Redis is unreachable, entries are appended to `./logs/model-responses.jsonl` instead, so logging never breaks a game turn. Note that the log contains full prompts and conversations.

## Discord

A game can be played in Discord: one **bridge** process (`discord-bridge.ts`) holds every bot from a gitignored `discord.config.mjs` (one bot per token, each serving a game, with free-form settings such as a stock symbol), reads the channel to rebuild each person's 1:1 conversation, and talks to the proxy like any OpenAI-compatible client; the answer is written into Discord by editing one message in place. The proxy never sees a bot token. Edits and deletes in Discord are repaired in the game's record by the sync layer. See `docs/DISCORD.md`.

## Running modes and sessions

| Mode | Start | Sessions |
|---|---|---|
| ephemeral (development) | `npm run start:ephemeral` | memory only |
| file (development, default) | `npm start` | one readable JSON per session in `SAVE_DIR` |
| production | `NODE_ENV=production` (or `ENV=production`) with `REDIS_URL` | Redis, shared by every proxy server |

In production the narrator (`UPSTREAM`) and the judge (`JUDGE_URL`) are assumed to be always on and nothing is spawned. Sessions in Redis are read and saved under a per-session lock (turns on one session run one at a time across servers) with a version check, so a stale writer cannot overwrite a newer turn. `npm run sessions -- export|import|clear|list` moves sessions between Redis and plain files so you can look at or edit what Redis holds. `INTERFACES` chooses the ways in (`src/modules/`; Open WebUI is the default). See `docs/DEPLOYMENT.md`.

## Tools

A game may let the narrator call tools (OpenAI-style function calling, supported by tool-capable Ollama models): `fetch` (allowed hosts only), `web_search`, `tmdb` (movie and TV facts, including "who was in every film of a franchise"), and `stock` (Yahoo quotes, news and options, with a time-travel clock that cuts all data off at a past moment in code). Which tools a game may use, and their limits, are in `config.json` `tools`; keys and endpoints are in a gitignored `tools.config.mjs`. Every call is bounded (hosts, count, size, time, no private addresses) and its result is treated as untrusted data. See `docs/TOOLS.md`.

## Failing gracefully
The server prefers a clear pause to a wrong answer. With a database configured and unreachable, games that need it say so ("bookkeeper unavailable") and play nothing until it is back; they never quietly change who is in charge of the cards or the money (a server-dealt table is never handed to the narrator mid-hand). A game that needs a database and has none refuses to start with a message saying why. Features that are only extras (tone rating, DMs, hiding a banned player from a Discord channel, MLflow traces) log one line and carry on; a notice that cannot be sent as a DM is told in the chat on the person's next reply. `npm run doctor` lists what is missing before you start.

## Starting from nothing (`npm run nuke`)
To debug the stack as a raw deployment, `node scripts/nuke.mjs` prints what it would do and `node scripts/nuke.mjs --yes` does it: `docker compose down -v`, empties the Postgres, RustFS, Redis and saved-session folders under `docker/volumes/`, removes `saves/`, `_cache/`, `logs/` and `dist/`, removes the `imeng` images and build cache (`--keep-images` keeps them, `--all-images` also removes the postgres, redis and minio images), and deletes the traces in the MLflow experiment named in `.env` (`--no-mlflow` skips it; `--mlflow-prefix <p>` also deletes experiments whose name starts with `<p>`; MLflow keeps deleted experiments in its trash until `mlflow gc` runs on the server). It never touches `.env`, the source or Ollama's models. Then `docker compose up -d --build` and `npm run doctor`.

## MLflow tracing

Optional. With `MLFLOW_TRACKING_URI` and `MLFLOW_EXPERIMENT_ID` set, every request in a game chat is sent to MLflow as one trace: a root span `turn N` and a span per model call (narrator, extractor, judge...), plus a `state.apply` span with how many ops were proposed, applied and skipped. It uses MLflow's OTLP/JSON endpoint (`<uri>/v1/traces`), so there are no extra dependencies. By default only timings, models, sizes and counts are sent; `MLFLOW_CAPTURE=full` also sends prompts and responses. A failed export is reported once per 30 seconds and never affects the game. In Docker Compose use the MLflow service name, e.g. `MLFLOW_TRACKING_URI=http://mlflow:5000`; MLflow needs a SQL backend (a file store answers 501). Details: `docs/MULTIPLAYER.md`.

Per-chat experiments (`--experiment-per-chat` / `MLFLOW_EXPERIMENT_PER_CHAT=1`, needs only `MLFLOW_TRACKING_URI`): each chat session gets its own experiment named `<model>-<local date-time>-T-<time zone>-<session>`, created when missing, and its traces go there. A restart makes a new name, so a chat resumed later starts a new experiment. The driver (`docs/DRIVER.md`) records test runs to MLflow too.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `IMENG_PATH` | `./imengs/dungeon-game` | Game folder. |
| `SAVE_DIR` | `./saves` | Where sessions are persisted. |
| `PORT` | `3001` | Proxy port. |
| `PROXY_BIND` | `127.0.0.1` (`0.0.0.0` in production) | The address the process listens on. Set it to the docker bridge address (`172.17.0.1`) so an Open WebUI container can reach a proxy on the host; compose also reads it for the published port. |
| `UPSTREAM` | `http://localhost:11434/v1` | Ollama's OpenAI-compatible API. |
| `OLLAMA_MODEL` | `gemma4:26b` | Narrator and extractor model. |
| `JUDGE_MODEL` | `config.json` `judge_model` | Overrides the judge model. |
| `JUDGE_INSTANCE` | | `off` disables the spawned judge instance. |
| `REDIS_URL` | none | Redis connection for the response log and the multiplayer seats (set in `.env`). |
| `JUDGE_URL` | none | Native Ollama API base of a judge that is already running (used by the Docker setup instead of spawning one). `JUDGE_BIND` is read by `npm run judge`. |
| `PROXY_API_KEY` | none | When set, `/v1` requires `Authorization: Bearer <key>` (and `/debug/state`, if enabled). Compose also reads `PROXY_RESTART` (default `no`: a restart policy makes foreground `up` hang after Ctrl+C on Compose 2.3.x; set `unless-stopped` for `up -d`), `PROXY_BIND`, `PROXY_PORT`, `PROXY_UPSTREAM`, `PROXY_GAME_DIR`, `NODE_VERSION`. |
| `ENABLE_DEBUG` | `1` | `0`/`false`/`off` removes the `/debug/state` endpoint (compose sets it to `0`). |
| `LOG_STREAM` | `game:model-responses` | Redis stream name. |
| `LOG_MAXLEN` | `100000` | Approximate max stream length. |
| `LOG_PROMPT_CHARS` | `20000` | Max prompt characters stored per entry. |
| `LOG_FILE` | `./logs/model-responses.jsonl` | Fallback log when Redis is down. |
| `NODE_ENV`, `ENV` | development | `production` assumes the narrator and judge are always on (nothing is spawned) and uses Redis for sessions when `REDIS_URL` is set. |
| `SESSION_STORE` | `auto` | `auto` (Redis in production with `REDIS_URL`, else files), `file` or `redis`. `--no-persist` always means memory. |
| `SESSION_PREFIX`, `SESSION_TTL_DAYS` | `imeng:<model_id>`, `30` | Redis key prefix of a game's sessions (games can share a Redis); how long an idle session is kept. |
| `SHOW_PRIVATE` | off | `1` shows `<private>...</private>` blocks in the narrator's replies (debugging). Normally they are for the narrator and the characters and never reach the player; the extractor still reads them. |
| `CONTEXT_MAX_TOKENS`, `CONTEXT_MAX_ROUNDS` | unset (no ceiling) | The machine guard for every game, so the hardware is never asked for more than it can carry. `CONTEXT_MAX_TOKENS`: a prompt estimated (characters / 4) above it is refused with HTTP 413 and the game's `too_long_reply`, before any model is called; nothing is saved. Set it above `compaction.at_tokens` and `wrap_up.at_tokens` (the doctor checks) and below the model's window. `CONTEXT_MAX_ROUNDS`: on that round the narrator closes the game with `wrap_up.text` (or a built-in line), then the game is over. Always hard: compaction does not relieve it. |
| `IMAGE_URL`, `IMAGE_MODEL`, `IMAGE_DIR`, `PUBLIC_URL`, `IMAGE_MAX_BYTES`, `IMAGE_TIMEOUT_MS`, `IMAGE_REF_ALLOW_PRIVATE` | see `docs/IMAGES.md` | Image generation (only with config.json `images`): the renderer's address, where pictures are stored, the address used in picture links, the size cap, the time one render may take, and whether a reference URL may point at a private address. |
| `SESSION_SCHEMA`, `SESSION_SCHEMA_SCAN_LIMIT` | `refuse`, `5000` | A stored session is stamped with the `schema_version` config.json declared when it was saved (unstamped = 1). One saved under another version loads only if every migration between has a `session` step; otherwise `refuse` stops the server at startup (naming the sessions and the fix), `warn` starts anyway, `off` skips the check. In Redis mode the startup scan reads up to the limit; a per-session check at load is the backstop. |
| `LOCK_TTL_MS`, `LOCK_WAIT_MS` | `60000`, `300000` | The per-session lock: its lease (renewed while a turn runs) and how long a turn waits for it. |
| `INTERFACES` | `openwebui` | Which interface modules to start (comma list: `openwebui`, `discord`). |
| `DISCORD_CONFIG` | `./discord.config.mjs` | Where the Discord bridge reads its bots and tokens (`.mjs`, `.js` or `.json`). |
| `TOOLS_CONFIG` | `./tools.config.mjs` | Where tool keys and endpoints are read from (`.mjs`, `.js` or `.json`). |
| `SAVE_COALESCE_MS` | `0` | `0` writes a session file at once. Above 0, saves are written in the background at most once per interval per session (newest state wins, unchanged states are skipped, pending saves are written on a clean exit). Try `250`. |
| `MULTIPLAYER_DEBUG` | off | `1` writes each request's headers (secrets hidden), message sizes and table to `SAVE_DIR/multiplayer-debug.jsonl`. |
| `PII_SALT` | `pii` | Secret that salts the PII tokens (`pii_filter`). Set it to a long random string: without it a phone number or email could be guessed back from a token. Never log it; changing it changes every token. |
| `ATTACH_CAPTURE`, `ATTACH_CACHE_DIR`, `ATTACH_MAX_BYTES`, `ATTACH_TTL_DAYS` | on, `./_cache`, 15 MB, 30 | Files people attach (Open WebUI uploads, Discord pictures) are kept in the bucket and recorded in the `attachments` table; `off` turns it off. After the TTL the `cleanup` service deletes the bucket object and the row. |
| `BUCKET_ENDPOINT`, `BUCKET_NAME`, `BUCKET_ACCESS_KEY`, `BUCKET_SECRET_KEY` | none | The S3-compatible file bucket (see "File bucket" above). The `cleanup` service needs them too, to delete expired files. |
| `IMENG_PATH` (was `GAME_DIR`) | `./imengs/dungeon-game` | The imeng folder; the old name is still read. Settings are `config.mjs`, `config.ts` or `config.json` (old `game.*` names still work). |
| `MLFLOW_SLOW_MS` | `2000` | A stage slower than this many ms is marked `bottleneck` in its MLflow span. Every trace carries the `imeng` tag. |
| `MLFLOW_TRACKING_URI` | none | MLflow tracking server, e.g. `http://mlflow:5000`. Tracing is on only when this and the experiment id are set. |
| `MLFLOW_EXPERIMENT_ID` | none | The experiment's **id** (the OTLP endpoint needs the id, not the name). |
| `MLFLOW_RUN_ID`, `MLFLOW_TRACKING_TOKEN` | none | Link traces to a run; send a Bearer token. |
| `MLFLOW_CAPTURE` | `meta` | `meta`: timings, models, sizes, counts. `full`: also prompts and responses (capped by `LOG_PROMPT_CHARS`). |
| `MLFLOW_TIMEOUT_MS`, `MLFLOW_DEBUG` | `5000`, off | Export timeout; `1` logs each export's size and time. |

## Endpoints

- `GET /v1/models`: model list for Open WebUI.
- `POST /v1/chat/completions`: the game endpoint (streaming and non-streaming).
- `GET /healthz`: liveness probe (never needs the API key).
- `GET /debug/state`: latest state and unsynced count per session (disabled with `ENABLE_DEBUG=0`).

