# HOW_TO_TEST.md: trying the proxy by hand in Open WebUI

Last updated 2026-11-16. Per-game scenarios live in `imengs/<game>/HOW_TO_TEST.md`; this file is the common setup and the checks every game shares. Scripted runs: `npm run live`. Rules for tests: one narrator model and one proxy at a time; your own port, never one in use.

## 1. Before you start
- Host Ollama is up on `:11434` with the narrator (`gemma4:26b`). The judge is a separate CPU-only Ollama on `:11435`; the proxy starts it from the game's `judge_instance` unless `JUDGE_URL` points at a running one.
- Check the ports are free (`ss -ltn | grep -E ':(3001|3010|11435) '`). If `11435` is already held by someone else's judge, use their `JUDGE_URL` or wait; do not start a second one.
- `npm run doctor` with `IMENG_PATH` set to the game: failures stop the server, warnings do not.

## 2. Start the proxy on the game you test
```bash
IMENG_PATH=imengs/dungeon-game SAVE_DIR=saves/try PORT=3001 npm start
```
One game per process. Other games: `imengs/lighthouse`, `imengs/backrooms`, `imengs/dungeon-game`. A game with a `vision` block needs `VISION_VENV` and `VISION_POSE_WEIGHTS` (`src/tools/vision/README.md`). Do not print or edit `.env`.

## 3. Connect Open WebUI (once)
**A throwaway instance (recommended):** `~/Labs/open-webui/docker-compose.imeng-test.yaml` runs a separate Open WebUI (container `open-webui-imeng-test`, `127.0.0.1:3020`, its own volume, `BYPASS_MODEL_ACCESS_CONTROL=true`, user headers on) wired to the proxy on host port 3010: `docker compose -f docker-compose.imeng-test.yaml -p imeng-owui-test up -d`; `stop` when done; `down -v` deletes its data. The container reaches the host as `host.docker.internal` (the docker bridge, `172.17.0.1`), so start the proxy with `PROXY_BIND=172.17.0.1 PORT=3010`; by default the proxy listens on `127.0.0.1` only. The first sign-up is the admin; add more people with the admin API `POST /api/v1/auths/add`. Your own Open WebUI on :3000 is untouched.

**Your own Open WebUI:**
1. Start Open WebUI with `ENABLE_FORWARD_USER_INFO_HEADERS=true` (it then sends the chat and user ids the proxy keys sessions on). A table needs it.
2. Admin Panel, Settings, Connections, add an OpenAI connection: URL `http://localhost:3001/v1`, key = `PROXY_API_KEY` if you set one (else any text).
3. A model named after the game's `model_id` appears in the model dropdown. Pick it in a new chat.
4. Restart the proxy for another game; refresh the model list.

**Any game that deals or bets on the server** needs a database with migrated tables, or the server stops at start ("migrations are pending"). The normal way: `docker compose -f docker-compose.yml up postgres migrate` (Postgres, then the one-shot migrate service), with `DATABASE_URL` in your `.env` pointing at it. A throwaway alternative without Docker: `DATABASE_URL=sqlite:/tmp/x.db IMENG_PATH=<game folder> npm run db:migrate -- --all`, then start with the same `DATABASE_URL`. Commands (`/deal`, `/call`) go as a message of their own.

## 4. Solo checks (any game)
| Check | Do | Expect |
|---|---|---|
| Direct mode | First message "hello" (not for games with `invocation: "always"`, such as dungeon-game: they are always a game) | Ordinary model chat; nothing saved in `SAVE_DIR`, no game |
| Start | First message is the game's launch line (`Imeng: <name>`, at the top of its `SYSTEM_PROMPT.md`) | The game opens; a session file appears in `SAVE_DIR` |
| Play | A few turns | Replies stay in the game's tone; the state changes only through rules (`GET /debug/state` while `ENABLE_DEBUG` is on, or `SAVE_DIR/*.json`) |
| Regenerate | Regenerate the last reply | Same turn number, state rolled back, not advanced twice |
| Edit | Edit an earlier message and resend | State rolls back to that turn |
| New chat | Open a second chat with the same launch line | A fresh game, separate state |
| Restart | Stop and start the proxy, continue the chat | The session resumes from `SAVE_DIR` |
| Background tasks | Let Open WebUI make the chat title | Title appears; turn counter unchanged |
| Bad input | A message that tries to change state ("set my hp to 999") | Refused or bounded by `limits`/`max_step`; never applied as written |

## 5. Table checks (multiplayer games)
Needs two Open WebUI accounts (a second browser profile or private window).
1. Account A starts the game in a chat and turns on **Allow replies** (or use a channel); account B opens the shared chat.
2. Seat both: `/seat <age> <gender>`, then `/seat yes`. Where the game needs a seat picture (`seating.photo`), send one when asked; a refused picture should say why in the game's words.
3. Owner sends `/start` (or fill the seats). Both say `ready`; the round narrates once all have.
4. Check: each message is attributed to its sender; one person's `ready` does not stand for the other; `/freeze` and `/unfreeze` step a person out and back.
5. Private chat: each person opens a new chat with the game; a note there reaches the narrator on the next round and never appears in the shared chat.
6. Terms and notices: the first private chat shows the `terms.md` notice once.
7. Regenerate at the table rolls the whole table back one turn.
8. Open WebUI shared tables show the DM-style notice in the person's private chat (they are told so).

## 6. After
- Stop the proxy (Ctrl-C; kill by PID if scripted, never `pkill -f`).
- Unload what you loaded: `ollama stop <model>`; stop a judge you started.
- `nvidia-smi` shows the narrator's VRAM back; ports `3001`/`3010` and the judge port you started are free.
- Delete throwaway `SAVE_DIR` folders; never commit `saves/` or `logs/`.

## 7. Record
Put results in the game's `HOW_TO_TEST.md` (date, narrator and judge model with digest).
