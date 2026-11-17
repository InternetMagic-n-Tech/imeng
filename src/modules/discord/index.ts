import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PRODUCTION } from "../../utils/config.js";
import { readBridgeAddress } from "./bridge/config.js";
import type { InterfaceModule } from "../index.js";

/**
 * The Discord interface, from the proxy's side. The connection to Discord is NOT in this process: a bot token allows one gateway connection and the
 * proxy may run on several servers, so one separate bridge process (discord-bridge.ts) holds all the bots and talks to the proxy like any
 * OpenAI-compatible client. This module only makes sure the bridge is there:
 *   production: it is assumed to be running (a warning if it does not answer);
 *   otherwise: if nothing answers on the bridge's port, it is started, and stopped again with the proxy.
 */

export interface BridgeDeps {
  address(): Promise<{ host: string; port: number }>;
  probe(host: string, port: number): Promise<boolean>;
  /** Start the bridge; returns something that can be stopped. */
  launch(cmd: string, args: string[]): { kill(): void };
  exists(file: string): boolean;
  sleep(ms: number): Promise<void>;
  production: boolean;
  cwd: string;
  log(line: string): void;
}

export const MISSING = [
  "regenerate and edit-and-resend: Discord has no such buttons; a message edited or deleted in Discord is picked up on the next message by the record's sync layer (config.json sync.mode repair)",
  "word-by-word streaming: an answer is one message edited in place about once a second, and split across messages at Discord's 2000-character limit",
  "reasoning: show (reasoning is never shown in Discord)",
  "reactions and slash commands: ignored; pictures attached to a message are passed on (png, jpeg, webp, gif; up to 3, 8 MB each)",
  "a table member seeing who said what inside one request: people are told apart by their Discord id",
];

/** What to run for the bridge: the built file if there is one, else the source through vite-node. */
export function bridgeCommand(cwd: string, exists: (f: string) => boolean): { cmd: string; args: string[] } {
  const built = path.join(cwd, "dist", "discord-bridge.js");
  if (exists(built)) return { cmd: process.execPath, args: [built] };
  return { cmd: process.execPath, args: [path.join(cwd, "node_modules", "vite-node", "dist", "cli.mjs"), path.join(cwd, "scripts/discord-bridge.ts")] };
}

export function createDiscordModule(deps: BridgeDeps): InterfaceModule & { /** Resolves when the bridge was found, or given up on (tests, and anything that wants to know). */ settled(): Promise<void> } {
  let child: { kill(): void } | null = null;
  let pending: Promise<void> = Promise.resolve();
  return {
    name: "discord",
    missing: MISSING,
    settled: () => pending,
    async start() {
      const { host, port } = await deps.address();
      const where = `http://${host}:${port}/healthz`;
      if (await deps.probe(host, port)) { deps.log(`[interface discord] the bridge is already running (${where})`); return; }
      if (deps.production) { deps.log(`[interface discord] production: the bridge is expected at ${where} but does not answer; start it with: npm run discord`); return; }
      const { cmd, args } = bridgeCommand(deps.cwd, deps.exists);
      deps.log(`[interface discord] nothing answers at ${where}: starting the bridge (${path.basename(args.at(-1) ?? "")})`);
      child = deps.launch(cmd, args);
      // Waiting for it happens in the background: a bridge that is slow, or cannot start (no config), must never hold up the proxy.
      pending = (async () => {
        for (let i = 0; i < 60; i++) {
          await deps.sleep(300);
          if (await deps.probe(host, port)) { deps.log("[interface discord] the bridge is up"); return; }
        }
        deps.log("[interface discord] the bridge did not answer within 18 s; see its output above (docs/DISCORD.md has the setup steps)");
      })();
    },
    stop() { child?.kill(); child = null; },
  };
}

const realDeps: BridgeDeps = {
  address: () => readBridgeAddress(),
  probe: (host, port) => new Promise((resolve) => {
    const req = http.get({ host, port, path: "/healthz", timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  }),
  launch: (cmd, args) => { const c = spawn(cmd, args, { stdio: "inherit", env: process.env }); c.on("error", (e) => console.warn("[interface discord] could not start the bridge:", e.message)); return { kill: () => { c.kill("SIGTERM"); } }; },
  exists: (f) => fs.existsSync(f),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  production: PRODUCTION,
  cwd: process.cwd(),
  log: (l) => console.log(l),
};

export default createDiscordModule(realDeps);
