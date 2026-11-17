import express from "express";
import { dbg } from "./utils/debug.js";
import { ENABLE_DEBUG, PROXY_API_KEY, INTERFACES } from "./utils/config.js";
import { requireApiKey } from "./utils/auth.js";
import { stateVerdict } from "./utils/db-state.js";
import { sessions } from "./utils/sessions.js";
import openwebui from "./modules/openwebui/index.js";

/*
 * Generic "game files" proxy between a chat interface and Ollama.
 * The server owns the game state; the model only narrates. See README.md.
 * This file only builds the HTTP app; a turn of the game is engine.ts, and the ways in are modules/.
 */

export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => { const t0 = Date.now(); const log = dbg("http"); log("-> %s %s", req.method, req.path); res.on("finish", () => log("<- %s %s %d %d ms", req.method, req.path, res.statusCode, Date.now() - t0)); res.on("close", () => { if (!res.writableFinished) log("!! %s %s closed early after %d ms", req.method, req.path, Date.now() - t0); }); next(); });

// Liveness probe for Docker / load balancers. Deliberately outside /v1 so it never needs the API key.
app.get("/healthz", (_req, res) => { const v = stateVerdict(); res.status(v.ok ? 200 : 503).json(v.ok ? { ok: true } : v); });

// Open WebUI (an OpenAI-compatible API under /v1) is the default interface and is mounted here so it exists as soon as this file is imported.
// Other interfaces (INTERFACES=openwebui,discord) are started by bootstrap.
if (INTERFACES.includes("openwebui")) openwebui.start({ app });

// Debug: inspect each session's current state (disable with ENABLE_DEBUG=0; keyed if PROXY_API_KEY is set)
if (ENABLE_DEBUG) {
  // The state is written after the reply has been sent (sync, setup, judges), so wait for each session to finish (up to DEBUG_WAIT_MS) before reading it.
  app.get("/debug/state", requireApiKey(PROXY_API_KEY), async (_req, res) => {
    const wait = Number(process.env.DEBUG_WAIT_MS ?? 30000);
    const out: Record<string, unknown> = {};
    for (const [k, s] of [...sessions]) {
      let timer: NodeJS.Timeout | undefined;
      const pending = await Promise.race([
        Promise.resolve(s.tail).then(() => false, () => false),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(true), wait); }),
      ]);
      clearTimeout(timer);
      out[k] = { state: s.snapshots.at(-1), pending, unsynced: s.unsynced.length, approximate: s.approximate, abandoned: s.abandoned, audit: s.audit?.slice(-10) };
    }
    res.json(out);
  });
}
