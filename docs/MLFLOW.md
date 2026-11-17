# MLflow tracing with docker compose

Optional. With MLflow running, every turn in a game chat becomes one trace: a root span `turn N`, a span per model call (narrator, extractor, judge...) and a `state.apply` span (ops proposed, applied, skipped). By default only timings, models, sizes and counts are sent; prompts and replies are not.

`docker-compose.yml` has an `mlflow` service behind the `mlflow` profile: it never starts unless you ask. Its data (SQLite database and artifacts) lives in `docker/volumes/mlflow`. The image tag is `latest`; pin a version once you pick one. This setup has not been run on every MLflow version: tracing needs a server that accepts OTLP at `/v1/traces`.

## 1. Start it

```bash
mkdir -p docker/volumes/mlflow          # so it is yours, not root's
docker compose --profile mlflow up -d mlflow
```

UI: http://localhost:15000 (`MLFLOW_PORT` in `.env` changes it; it binds to `PROXY_BIND`, localhost by default).

## 2. Make an experiment and note its id

```bash
curl -s -X POST http://localhost:15000/api/2.0/mlflow/experiments/create \
  -H 'Content-Type: application/json' -d '{"name":"imeng"}'
# {"experiment_id":"1"}
```

## 3. Point the proxy at it

In `.env`:

```
MLFLOW_TRACKING_URI=http://localhost:15000
MLFLOW_EXPERIMENT_ID=1
```

Start the proxy or the hub on the host as usual (`npm run hub:ephemeral`). Play a turn and open the experiment's Traces tab.

If the proxy itself runs in compose, it must reach MLflow by service name, and the variables must reach the container (add them under `environment:` of the proxy service): `MLFLOW_TRACKING_URI=http://mlflow:5000`.

## Options

| Setting | Effect |
|---|---|
| `MLFLOW_CAPTURE=full` | Also sends prompts and responses. They can hold what players typed: turn it on only for your own tests. |
| `MLFLOW_EXPERIMENT_PER_CHAT=1` or `--experiment-per-chat` | Every chat session is its own experiment, created when missing. Needs only `MLFLOW_TRACKING_URI`, no experiment id. |
| `--no-telemetry` or `TELEMETRY=off` | Sends nothing, whatever a game or its owner says. |

A failed export is reported once per 30 seconds and never affects the game. The test driver (`docs/DRIVER.md`) records runs to MLflow too. MLflow needs a SQL backend (the file store answers 501 on the trace endpoint); the compose service uses SQLite.

## Stop and clean

```bash
docker compose --profile mlflow stop mlflow
node scripts/nuke.mjs        # prints what it would delete, including the traces in the experiment named in .env
```

More: "MLflow tracing" in docs/OPERATIONS.md and `docs/MULTIPLAYER.md`.
