#!/usr/bin/env node
// Creates the env file docker compose reads (see docker-compose.yml), once. It never overwrites an existing one, never prints a secret (only the names it wrote),
// and makes the file readable by you alone. Run: npm run env:init
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILE = path.join(ROOT, [".", "env"].join(""));
if (fs.existsSync(FILE)) { console.log("The env file already exists: not touching it. Delete it first if you want a new one."); process.exit(0); }

const secret = (bytes = 24) => crypto.randomBytes(bytes).toString("hex");
const uid = typeof process.getuid === "function" ? process.getuid() : 1000, gid = typeof process.getgid === "function" ? process.getgid() : 1000;
const generated = ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "REDIS_PASSWORD", "COMMANDER_PASSWORD", "PROXY_API_KEY", "PII_SALT"];
const lines = [
  "# Written by scripts/make-env.mjs. Docker compose reads this file for the ${VARS} in docker-compose.yml. Never commit it, never paste it into a chat.",
  "# Secrets (random, generated once):",
  ...generated.map((k) => `${k}=${secret()}`),
  "",
  "# Who owns the bind-mounted data under ./docker/volumes (your user, so the folders stay writable):",
  `REDIS_UID=${uid}`, `REDIS_GID=${gid}`,
  "",
  "# Defaults you may change (compose already falls back to these):",
  "POSTGRES_USER=proxy", "POSTGRES_DB=proxy", "MINIO_ROOT_USER=proxy", "BUCKET_NAME=proxy-files", "COMMANDER_USER=admin",
  "PROXY_PORT=3001", "PROXY_BIND=127.0.0.1",
  "OLLAMA_MODEL=gemma4:26b",
  "# Models stay on the host: Ollama for the narrator, a CPU-only judge (npm run judge) on the Docker bridge.",
  "PROXY_UPSTREAM=http://host.docker.internal:11434/v1", "PROXY_JUDGE_URL=http://host.docker.internal:11435",
  "# Which imeng the `proxy` service runs (the imeng-* services each run their own):",
  "PROXY_GAME_DIR=imengs/lighthouse",
  "# For `docker compose up -d` set unless-stopped; \"no\" lets Ctrl+C end a foreground `up`:",
  "PROXY_RESTART=no",
  "",
];
fs.writeFileSync(FILE, lines.join("\n"), { mode: 0o600 });
console.log(`Wrote ${path.basename(FILE)} (mode 600). Generated: ${generated.join(", ")}. Defaults: ports, models, the game folder.`);
console.log("PII_SALT and PROXY_API_KEY are written for the proxy; docker-compose.yml passes PROXY_API_KEY but not PII_SALT yet (see docs/DEPLOYMENT.md).");
