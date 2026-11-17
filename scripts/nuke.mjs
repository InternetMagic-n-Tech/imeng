#!/usr/bin/env node
// Nuke: put the machine back to "nothing has ever run" so the whole stack can be debugged from a raw deployment, end to end.
//   node scripts/nuke.mjs            prints what it would do (dry run)
//   node scripts/nuke.mjs --yes      does it
// Options: --keep-images (leave the imeng image), --all-images (also remove the postgres, redis, rustfs and redis-commander images),
//          --no-mlflow, --mlflow-prefix <p> (also delete experiments whose name starts with <p>; per-chat experiments are named after the model id).
// Never touches .env, the source, or Ollama and its models.
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const go = has("--yes");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const say = (m) => console.log(`${go ? "" : "[dry run] "}${m}`);
const run = (cmd) => { say(cmd); if (!go) return; const r = spawnSync(cmd, { shell: true, cwd: root, stdio: "inherit" }); if (r.status) console.warn(`  (exit ${r.status}, carrying on)`); };

// 1. containers and their named volumes
run("docker compose --profile '*' down -v --remove-orphans");

// 2. bind-mounted data (the database, the bucket, redis, saved sessions). Postgres owns its files, so a plain delete may be refused: a throwaway container does it.
const vol = path.join(root, "docker", "volumes");
for (const sub of ["pgsql", "minio", "redis", "proxy"]) {
  const dir = path.join(vol, sub);
  if (!fs.existsSync(dir)) continue;
  say(`empty ${path.relative(root, dir)}`);
  if (!go) continue;
  try { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true }); }
  catch { run(`docker run --rm -v "${dir}:/d" alpine sh -c "rm -rf /d/* /d/.[!.]*"`); }
}
// the old, singular folder some earlier setups used
if (fs.existsSync(path.join(root, "docker", "volume"))) say("note: docker/volume (singular) exists from an older setup; move or delete it by hand");

// 3. local working data
for (const d of ["saves", "_cache", "logs", "dist"]) if (fs.existsSync(path.join(root, d))) { say(`remove ${d}/`); if (go) fs.rmSync(path.join(root, d), { recursive: true, force: true }); }

// 4. images
if (!has("--keep-images")) {
  run("docker rmi -f imeng:latest");
  try {
    const mine = execSync("docker images --format '{{.Repository}}:{{.Tag}}' | grep -i '^imeng' || true", { cwd: root }).toString().split("\n").filter(Boolean);
    for (const i of mine) run(`docker rmi -f ${i}`);
  } catch { /* no docker here */ }
  if (has("--all-images")) for (const i of ["postgres", "redis", "rustfs/rustfs", "ghcr.io/joeferner/redis-commander"]) run(`docker image ls -q ${i} | xargs -r docker rmi -f`);
  run("docker image prune -f");
  run("docker builder prune -f");
}

// 5. MLflow: every trace carries the `imeng` tag, and the traces live in the configured experiment (and one experiment per chat when that mode is on)
if (!has("--no-mlflow")) {
  const env = fs.existsSync(path.join(root, ".env")) ? Object.fromEntries(fs.readFileSync(path.join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")])) : {};
  const uri = (process.env.MLFLOW_TRACKING_URI || env.MLFLOW_TRACKING_URI || "").replace(/\/+$/, "");
  const exp = process.env.MLFLOW_EXPERIMENT_ID || env.MLFLOW_EXPERIMENT_ID;
  const token = process.env.MLFLOW_TRACKING_TOKEN || env.MLFLOW_TRACKING_TOKEN;
  if (!uri) say("MLflow: MLFLOW_TRACKING_URI is not set, skipping");
  else {
    const call = async (p, body) => {
      const r = await fetch(`${uri}/api/2.0/mlflow/${p}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${p} answered ${r.status}`);
      return r.json().catch(() => ({}));
    };
    try {
      if (exp) { say(`MLflow: delete every trace in experiment ${exp}`); if (go) console.log("  ", JSON.stringify(await call("traces/delete-traces", { experiment_id: exp, max_timestamp_millis: Date.now() + 60_000 }))); }
      const prefix = val("--mlflow-prefix");
      if (prefix) {
        const found = (await call("experiments/search", { max_results: 1000 })).experiments ?? [];
        for (const e of found.filter((x) => String(x.name).startsWith(prefix))) { say(`MLflow: delete experiment ${e.name} (${e.experiment_id})`); if (go) await call("experiments/delete", { experiment_id: e.experiment_id }); }
        if (go) say("MLflow: deleted experiments stay in its trash until `mlflow gc` runs on the server");
      }
    } catch (e) { console.warn(`MLflow: ${e.message} (carrying on)`); }
  }
}
console.log(go ? "Done. Next: docker compose up -d --build, then npm run doctor against the fresh stack." : "Nothing was changed. Run again with --yes to do it.");
