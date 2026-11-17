import express from "express";
import { MODEL_ID, PROXY_API_KEY, IMENG_PATH, config } from "../../utils/config.js";
import { readIcon, sendIcon } from "../../utils/icon.js";
import { requireApiKey } from "../../utils/auth.js";
import { ExpressSink } from "../../utils/sink.js";
import { runTurn } from "../../engine.js";
import { IMAGES } from "../../utils/image-config.js";
import { readImage } from "../../utils/image-store.js";
import type { InterfaceModule } from "../index.js";
import { OLLAMA_VERSION, tagsBody, showBody, ollamaFacade, asOpenAI } from "./ollama.js";

/** The default interface: an OpenAI-compatible HTTP API (what Open WebUI and most clients speak). */
const openwebui: InterfaceModule = {
  name: "openwebui",
  start({ app }) {
    // Auth runs before the body is parsed, so unauthenticated callers can't make us buffer 10 MB.
    app.use("/v1", requireApiKey(PROXY_API_KEY));
    app.use("/v1", express.json({ limit: "10mb" }));
    app.get("/v1/models", (_req, res) => {
      res.json({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "me" }] });
    });
    app.get("/icons/:id", (req, res) => sendIcon(res, req.params.id === MODEL_ID ? readIcon(IMENG_PATH, config.icon) : null)); // the game's picture (config.icon): public, it is only an image
    if (IMAGES) { // pictures made by /draw and /portrait: the file name is a content hash, nothing else is served from here
      app.get("/images/:file", (req, res) => {
        const img = readImage(String(req.params.file));
        if (!img) { res.status(404).end(); return; }
        res.set("Content-Type", img.type).set("Cache-Control", "public, max-age=31536000, immutable").send(img.bytes);
      });
    }
    // Eviction (the Discord bridge calls this when the bot is removed from a channel, a thread or a server). Needs PROXY_API_KEY: it deletes data.
    app.post("/admin/evict", (req, res, next) => (PROXY_API_KEY ? next() : void res.status(403).json({ error: { message: "Set PROXY_API_KEY to use /admin/evict." } })), requireApiKey(PROXY_API_KEY), express.json({ limit: "10kb" }), async (req, res) => {
      const prefixes: string[] = (Array.isArray(req.body?.prefixes) ? req.body.prefixes : [req.body?.prefix]).filter((p: unknown): p is string => typeof p === "string" && p.length >= 8).slice(0, 200);
      if (!prefixes.length) { res.status(400).json({ error: { message: "prefixes: a list of chat key prefixes (at least 8 characters each) is required." } }); return; }
      const { evictPrefix } = await import("../../utils/evict.js");
      const out = [];
      for (const p of prefixes) out.push({ prefix: p, ...(await evictPrefix(p)) });
      res.json({ ok: true, evicted: out });
    });
    // Events for one person that an adapter may push (the Discord bridge sends them as direct messages), and the adapter saying it did. Needs PROXY_API_KEY.
    const adminOnly = (req: express.Request, res: express.Response, next: express.NextFunction): void => (PROXY_API_KEY ? next() : void res.status(403).json({ error: { message: "Set PROXY_API_KEY to use /admin." } }));
    app.get("/admin/announcements", adminOnly, requireApiKey(PROXY_API_KEY), async (req, res) => {
      const { sessions } = await import("../../utils/sessions.js");
      const { pendingFor } = await import("../../utils/announce.js");
      res.json({ items: pendingFor(sessions.entries(), String(req.query.prefix ?? "discord:")) });
    });
    app.post("/admin/announcements/ack", adminOnly, requireApiKey(PROXY_API_KEY), express.json({ limit: "100kb" }), async (req, res) => {
      const { sessions, saveSession } = await import("../../utils/sessions.js");
      const { markDelivered } = await import("../../utils/announce.js");
      const items = (Array.isArray(req.body?.items) ? req.body.items : []).filter((i: any) => typeof i?.key === "string" && typeof i?.id === "string").slice(0, 500);
      const n = markDelivered(sessions, items);
      for (const k of new Set<string>(items.map((i: any) => String(i.key)))) { const s = sessions.get(k); if (s) saveSession(k, s); }
      res.json({ ok: true, delivered: n });
    });
    // The outside payment service tells the game a re-entry code was paid, or that a player has play credit. Needs PROXY_API_KEY.
    app.post("/admin/credit", (req, res, next) => (PROXY_API_KEY ? next() : void res.status(403).json({ error: { message: "Set PROXY_API_KEY to use /admin/credit." } })), requireApiKey(PROXY_API_KEY), express.json({ limit: "10kb" }), async (req, res) => {
      const { stateDb } = await import("../../utils/db-state.js");
      const { markPaidChecked, addCredit } = await import("../../utils/credit.js");
      const { CREDIT } = await import("../../utils/config.js");
      const db = stateDb();
      if (!db) { res.status(503).json({ error: { message: "No database." } }); return; }
      const unit = CREDIT?.currency ?? "chips";
      if (typeof req.body?.paid_code === "string") {
        const r = await markPaidChecked(db, req.body.paid_code, { amount: req.body.amount, currency: req.body.currency, require: CREDIT?.requireTerms });
        if (r.reason === "terms") { res.status(409).json({ ok: false, error: { message: "The amount or the currency does not match the terms the code was issued under." } }); return; }
        res.json({ ok: r.ok }); return;
      }
      const amount = Number(req.body?.credit);
      if (typeof req.body?.user_id === "string" && Number.isInteger(amount) && amount > 0) {
        if ((req.body.currency !== undefined && String(req.body.currency) !== unit) || (CREDIT?.requireTerms && req.body.currency === undefined) || amount > (CREDIT?.maxCredit ?? 100000)) { res.status(409).json({ ok: false, error: { message: `Credit must be a whole number up to ${CREDIT?.maxCredit ?? 100000} in ${unit}.` } }); return; } res.json({ ok: true, credit: await addCredit(db, { game: MODEL_ID, userId: req.body.user_id }, Number(req.body.credit)) }); return; }
      res.status(400).json({ error: { message: "Send {paid_code} or {user_id, credit}." } });
    });
    app.post("/v1/chat/completions", (req, res) => void runTurn(req, new ExpressSink(res, !!req.body.stream)));
    // An Ollama connection pointed at the proxy: the game is the only model.
    app.use("/api", requireApiKey(PROXY_API_KEY));
    app.use("/api", express.json({ limit: "10mb" }));
    app.get("/api/tags", (_req, res) => void res.json(tagsBody(MODEL_ID)));
    app.get("/api/version", (_req, res) => void res.json({ version: OLLAMA_VERSION }));
    app.get("/api/ps", (_req, res) => void res.json({ models: [] }));
    app.post("/api/show", (_req, res) => void res.json(showBody(MODEL_ID)));
    app.post("/api/chat", (req, res) => { const stream = asOpenAI(req); void runTurn(req, new ExpressSink(ollamaFacade(res, MODEL_ID, stream) as typeof res, stream)); });
  },
};

export default openwebui;
