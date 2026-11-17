import path from "node:path";
import type { Server } from "node:http";
import { onKill } from "../utils/shutdown.js";
import { buildHubApp } from "./app.js";
import { realChildDeps, startChildren } from "./children.js";
import type { ChildDeps, HubChild } from "./children.js";
import { discoverGames } from "./games.js";
import { iconUrl, readIcon } from "../utils/icon.js";

export interface HubSettings {
  port: number;
  host: string;
  apiKey: string;
  root: string;
  saveBase: string;
  skip: string[];
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  childTimeoutMs: number;
  publicUrl: string;
}

/** Hub settings from the environment. Never imports config.ts: that file loads one game, and the hub loads none. */
export function hubSettings(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2), cwd = process.cwd()): HubSettings {
  const production = env.NODE_ENV === "production";
  return {
    port: Number(env.PORT || 3001),
    host: env.PROXY_BIND?.trim() || (production ? "0.0.0.0" : "127.0.0.1"),
    apiKey: env.PROXY_API_KEY ?? "",
    root: path.resolve(cwd, env.IMENGS_ROOT || "imengs"),
    saveBase: path.resolve(cwd, env.SAVE_DIR || "saves"),
    skip: (env.HUB_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cwd,
    args: argv,
    env,
    childTimeoutMs: Number(env.HUB_CHILD_TIMEOUT_MS || 90000),
    publicUrl: (env.PUBLIC_URL || `http://localhost:${Number(env.PORT || 3001)}`).replace(/\/+$/, ""),
  };
}

/** Start every game and listen. Resolves to the server, or null when nothing could start (the reason is logged). */
export async function startHub(s: HubSettings, deps: ChildDeps = realChildDeps(), log: (l: string) => void = console.log): Promise<{ server: Server; children: HubChild[] } | null> {
  const { games, problems } = await discoverGames(s.root, s.skip);
  for (const p of problems) log(`[hub] ${p}`);
  if (!games.length) { log(`[hub] no games found under ${s.root}`); return null; }
  const children = await startChildren(games, { cwd: s.cwd, saveBase: s.saveBase, env: s.env, args: s.args, timeoutMs: s.childTimeoutMs, publicUrl: s.publicUrl }, deps);
  onKill(() => { for (const c of children) c.stop(); });
  if (!children.length) { log("[hub] no game started"); return null; }
  if (!s.apiKey && s.host !== "127.0.0.1" && s.host !== "localhost") log(`[hub] PROXY_API_KEY is not set and the hub listens on ${s.host}: /v1 is open to anyone who can reach it`);
  const dirOf = new Map(games.map((g) => [g.modelId, g]));
  for (const c of children) { const g = dirOf.get(c.modelId); if (g?.icon) log(readIcon(g.dir, g.icon) ? `[hub] ${c.modelId} picture: ${iconUrl(s.publicUrl, c.modelId)} (to use it in Open WebUI, upload ${path.join(g.dir, g.icon)} in Workspace > Models)` : `[hub] ${c.modelId}: icon "${g.icon}" is not usable (a png, jpg, webp or gif file of up to 2 MB in the game folder)`); }
  const app = buildHubApp(children, { apiKey: s.apiKey, iconOf: (id) => { const g = dirOf.get(id); return g ? readIcon(g.dir, g.icon) : null; } });
  return new Promise((resolve) => {
    let settled = false;
    const fail = (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      log(e.code === "EADDRINUSE" ? `[hub] port ${s.port} is already in use. Stop the other process or set PORT.` : `[hub] could not listen on port ${s.port}: ${e.message}`);
      for (const c of children) c.stop();
      resolve(null);
    };
    const server = app.listen(s.port, s.host, (err?: Error) => {
      if (err) return fail(err);
      settled = true;
      log(`[hub] listening on ${s.host}:${(server.address() as { port: number }).port}: ${children.map((c) => c.modelId).join(", ")}`);
      resolve({ server, children });
    });
    server.once("error", fail);
  });
}
