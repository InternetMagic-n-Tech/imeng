import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { HubGame } from "./games.js";

export interface ChildHandle {
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface ChildDeps {
  freePort(): Promise<number>;
  launch(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, label: string): ChildHandle;
  /** True when the child's /healthz answers 200. */
  ready(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  exists(file: string): boolean;
  log(line: string): void;
}

export interface HubChild {
  modelId: string;
  baseUrl: string;
  secret: string;
  up(): boolean;
  stop(): void;
}

export interface ChildConfig {
  cwd: string;
  saveBase: string;
  env: NodeJS.ProcessEnv;
  /** Flags for server.js (for example --no-persist). */
  args: string[];
  timeoutMs: number;
  /** What the games use as PUBLIC_URL, so links they make point at the hub. */
  publicUrl?: string;
}

/** Children never read .env: the hub already loaded and expanded it, and they get its environment. (Without this flag each would load .env again.) */
const NO_ENV_FILE = "--env-file-if-exists=/dev/null";

/** What to run for one game: the built server if there is one, else the source through vite-node. */
export function serverCommand(cwd: string, exists: (f: string) => boolean): { cmd: string; args: string[] } {
  const built = path.join(cwd, "dist", "server.js");
  if (exists(built)) return { cmd: process.execPath, args: [NO_ENV_FILE, built] };
  return { cmd: process.execPath, args: [NO_ENV_FILE, path.join(cwd, "node_modules", "vite-node", "dist", "cli.mjs"), path.join(cwd, "scripts/server.ts")] };
}

/** The environment for one child: the hub's, minus what picks a game or an interface, plus loopback-only listening and a secret only the hub knows. */
export function childEnv(base: NodeJS.ProcessEnv, game: HubGame, port: number, secret: string, saveBase: string, publicUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ["GAME_DIR", "SYSTEM_PROMPT_PATH", "IMENGS_ROOT", "HUB_SKIP"]) delete env[k];
  return { ...env, IMENG_PATH: game.dir, SAVE_DIR: path.join(saveBase, game.slug), PORT: String(port), PROXY_BIND: "127.0.0.1", PROXY_API_KEY: secret, INTERFACES: "openwebui", IMENG_HUB_CHILD: "1", ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}) };
}

/**
 * Start one process per game, one after another (the first one may start the shared judge, and the next must find it listening).
 * A game that exits or does not answer /healthz in time is left out and reported; the others carry on.
 */
export async function startChildren(games: HubGame[], cfg: ChildConfig, deps: ChildDeps): Promise<HubChild[]> {
  const out: HubChild[] = [];
  const { cmd, args } = serverCommand(cfg.cwd, deps.exists);
  for (const game of games) {
    const port = await deps.freePort();
    const secret = crypto.randomBytes(24).toString("hex");
    let alive = true;
    let up = false;
    deps.log(`[hub] starting ${game.modelId} (${path.relative(cfg.cwd, game.dir) || game.dir}) on 127.0.0.1:${port}`);
    const proc = deps.launch(cmd, [...args, ...cfg.args], childEnv(cfg.env, game, port, secret, cfg.saveBase, cfg.publicUrl), cfg.cwd, game.modelId);
    proc.onExit((code) => { alive = false; if (up) deps.log(`[hub] ${game.modelId} stopped (exit ${code}); requests for it get 503`); up = false; });
    const deadline = Date.now() + cfg.timeoutMs;
    while (alive && !up && Date.now() < deadline) {
      if (await deps.ready(port)) { up = true; break; }
      await deps.sleep(300);
    }
    if (!up) {
      deps.log(alive ? `[hub] ${game.modelId} did not answer within ${Math.round(cfg.timeoutMs / 1000)} s: left out (see its output above)` : `[hub] ${game.modelId} exited before it was ready: left out (see its output above)`);
      proc.kill();
      continue;
    }
    deps.log(`[hub] ${game.modelId} is up`);
    out.push({ modelId: game.modelId, baseUrl: `http://127.0.0.1:${port}`, secret, up: () => up, stop: () => proc.kill() });
  }
  return out;
}

export const realChildDeps = (log: (l: string) => void = console.log): ChildDeps => ({
  freePort: () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  }),
  launch: (cmd, args, env, cwd, label) => {
    const c = spawn(cmd, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    c.on("error", (e) => log(`[hub] could not start ${label}: ${e.message}`));
    return { kill: () => { if (c.exitCode === null && !c.killed) c.kill("SIGTERM"); }, onExit: (cb) => { c.on("exit", (code) => cb(code)); c.on("error", () => cb(null)); } };
  },
  ready: (port) => new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  exists: (f) => fs.existsSync(f),
  log,
});
