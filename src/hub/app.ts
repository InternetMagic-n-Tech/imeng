import express from "express";
import type { Express, Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireApiKey } from "../utils/auth.js";
import type { HubChild } from "./children.js";
import { sendIcon } from "../utils/icon.js";
import type { Icon } from "../utils/icon.js";

export interface HubOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for a child's model list. */
  listTimeoutMs?: number;
  /** A game's picture by model id (null: none). Served at /icons/<model id>, public. */
  iconOf?: (modelId: string) => Icon | null;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length", "authorization", "accept-encoding"]);
const DROP_BACK = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

const errorBody = (message: string) => ({ error: { message } });

/**
 * One port in front of one process per game. It lists every game's model and sends each chat request to the process that owns the model, so every
 * game stays in its own process (its own state, saves and settings). It checks the caller's key; each child accepts only the hub's own secret.
 * Open WebUI's headers (x-openwebui-*) go through unchanged, and the answer streams back as it arrives.
 */
export function buildHubApp(children: HubChild[], opts: HubOptions): Express {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const byModel = new Map(children.map((c) => [c.modelId, c]));
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    const games = children.map((c) => ({ model: c.modelId, up: c.up() }));
    const ok = games.some((g) => g.up);
    res.status(ok ? 200 : 503).json({ ok, games });
  });

  app.get("/icons/:id", (req, res) => sendIcon(res, byModel.has(req.params.id) ? opts.iconOf?.(req.params.id) ?? null : null));

  app.use("/v1", requireApiKey(opts.apiKey));

  app.get("/v1/models", async (_req, res) => {
    const seen = new Set<string>();
    const data: unknown[] = [];
    await Promise.all(children.filter((c) => c.up()).map(async (c) => {
      try {
        const r = await fetchImpl(`${c.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${c.secret}` }, signal: AbortSignal.timeout(opts.listTimeoutMs ?? 3000) });
        if (!r.ok) return;
        for (const m of ((await r.json()) as { data?: { id?: string }[] }).data ?? []) if (m?.id && !seen.has(m.id)) { seen.add(m.id); data.push(m); }
      } catch { /* a slow or dead child drops out of the list for now */ }
    }));
    data.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
    res.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", express.json({ limit: "10mb", verify: (req, _res, buf) => { (req as Request & { raw?: Buffer }).raw = buf; } }), async (req: Request, res: Response) => {
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    const child = byModel.get(model);
    if (!child) { res.status(404).json(errorBody(`Unknown model "${model}". Known: ${[...byModel.keys()].sort().join(", ") || "none"}`)); return; }
    if (!child.up()) { res.status(503).json(errorBody(`The game for "${model}" is not running`)); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    headers.authorization = `Bearer ${child.secret}`;
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    try {
      const up = await fetchImpl(`${child.baseUrl}/v1/chat/completions`, { method: "POST", headers, body: new Uint8Array((req as Request & { raw?: Buffer }).raw ?? Buffer.from(JSON.stringify(req.body))), signal: abort.signal });
      res.status(up.status);
      up.headers.forEach((v, k) => { if (!DROP_BACK.has(k.toLowerCase())) res.setHeader(k, v); });
      if (!up.body) { res.end(); return; }
      await pipeline(Readable.fromWeb(up.body as never), res);
    } catch (e) {
      if (abort.signal.aborted) return;
      if (!res.headersSent) res.status(502).json(errorBody(`The game for "${model}" did not answer: ${(e as Error).message}`));
      else res.destroy();
    }
  });

  return app;
}
