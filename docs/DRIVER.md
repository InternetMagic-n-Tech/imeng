# DRIVER.md

`scripts/driver.mjs` (TypeScript in `driver.ts`, run through vite-node: no build step) is the testing helper. `npm run driver -- <command>`; every flag has an environment variable, and **a flag always wins** over its variable, which wins over the default.

| Command | Does |
| --- | --- |
| `run <cases or game folders...>` | Runs test cases, one child process per case and model (a crash or a dead model is contained and recorded). A game folder runs its `cases/*.md`. |
| `how-to-test [game]` | Runs the game's cases; with none, prints its `HOW_TO_TEST.md`. Each example has `npm run how-to-test` (extra flags after `--`). |
| `build [games...]` | Builds prompt templates and moves inline base64 images to `assets/` (see IMENG-MAKING "Prompt templates and the build step"). `--force`. Each example has `npm run build:prompts`. |
| `check [games...]` | Fails if a game folder lacks `VISION.md` or `HOW_TO_TEST.md` (default: every folder in `imengs/`). |
| `zip` | A zip of the files changed since the last zip (below). |

## A case

One markdown file in `<game>/cases/`. Links to other `.md` files work as in prompt templates, so cases can share parts.

```md
---
game: ..
name: all in then leave
models: { narrator: gemma4:26b }
state:                 # merged onto the game's starting state; or a file path
  actors:
    user: { name: Gus, chips: 200 }
history: []            # earlier chat messages, or a file path
private: ["I trust the house to settle me up"]   # private notes sent before the steps, or a file path
---
## Steps
1. Gus: "Omaha. All in on the first hand, I have to go mow the lawn."
2. "bye"

## Expect
- state: actors.user.chips >= 0        # ops: == != > >= < <= contains present
- text: contains "settle"              # or: not contains, matches /regex/ ; prefix `last` for the final reply only
- judge: the dealer lets the player leave
```

`state:` and `text:` lines are checked by code. A `judge:` line is decided by the judge model, given the game's `VISION.md`, its system prompt, the final state and the transcript: write `VISION.md` so a small model can tell what is being tested. The command line overrides the header: `--state`, `--history`, `--private` (a file or a JSON/YAML string), `--game`.

## Models, judge, MLflow

- `--model` (`OLLAMA_MODEL`) is the main model. `--compare` / `COMPARE_MODELS` is a list (JSON array or comma list) to run as well; `--compare-prefer N` / `COMPARE_PREFER` forces only compare model N (1-based). `--judge-model` / `DRIVER_JUDGE_MODEL` is an alternative judge for `judge:` lines.
- With `--mlflow-url` / `MLFLOW_TRACKING_URI` each case and model is recorded as a run: parameters (models, whether the compare model was forced), metrics (pass, checks, model-call failures, times), tags (`model.failed`, `prompt.matched`, `prompt.version`), the transcript, the prompt that reached the model (`prompt-sent.txt`), and a diff when the game's prompt matches no stored version. The experiment is `--experiment` / `MLFLOW_EXPERIMENT_NAME` (created when missing), or with `--experiment-per-chat` / `MLFLOW_EXPERIMENT_PER_CHAT` one per case chat: `<model>-2026-05-28-143015-T-America-Toronto-<session>`.
- Prompt matching ignores HTML comments, punctuation and white space; the prompt is registered as `<GAME>-SYSTEM_PROMPT.md`.
- The same flag makes the proxy itself (not only the driver) put each chat session in its own experiment, off by default. Traces go to that experiment.

## Machine load

`NODE_ENV=production` is the high-performance profile (8 cases at once, 2 retries); anything else is gentle (one at a time, 3 retries, longer backoff) so the IDE on the same machine is not starved. Tune with `DRIVER_CONCURRENCY`, `DRIVER_RETRIES`, `DRIVER_BACKOFF_MS`, `DRIVER_BACKOFF_MAX_MS`, `DRIVER_TASK_TIMEOUT_MS`, or `--concurrency` / `--retries`. The pipeline runner (`src/utils/pipeline.ts`) is the reusable piece: arrays of promise-returning functions, a `then/catch/finally` map per stage, the next array, and so on, with `all`, `allSettled`, `race` or `series` per stage, retry with exponential backoff and a concurrency limit.

## Zip

`npm run zip:changes` writes `<folder>-changes-<n>.zip` beside the project with the files that are new or changed since the last zip (hashes are kept in `.zip-state.json`; removed files are listed in `ZIP-DELETED.txt` inside). The first zip has no baseline: use `--since <last zip file or date>` or `--all`. `--src` (`ZIP_SRC`) and `--out` (`ZIP_OUT`) pick the folder and the file.

## Standards

Typed helpers, small files, no English hard-coded in the engine, every model and network call faked in tests, `console.log` timings around heavy calls.

## `driver db`: a fresh database, a query, an exact outcome

`npm run driver -- db <file.json | '{"...":1}'>` builds a throwaway database from the migrations (SQLite in memory by default; `"url":"postgres://..."` for a real one), seeds it, runs one query and compares the outcome exactly. Exit 1 on any difference.

```json
{ "seed": { "players": [{ "user_id": "u1", "name": "Bea", "created_at": 1, "seen_at": 5, "expires_at": 9999999999999 }] },
  "query": "select user_id from players where seen_at > ?", "params": [4],
  "expect": { "rows": [{ "user_id": "u1" }] } }
```
`expect` is `{rows}` (same order, or `"unordered": true`), `{count}` or `{none: true}`. Not built yet: seeding rows and asserting on rows from a case file's front matter.
