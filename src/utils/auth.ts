import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const sha = (s: string): Buffer => crypto.createHash("sha256").update(s).digest();

/** Constant-time string comparison (compares fixed-length digests, so length is not leaked). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

/**
 * Express middleware requiring `Authorization: Bearer <key>`. With an empty key it lets everything
 * through (auth disabled), which keeps local use frictionless.
 */
export function requireApiKey(key: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!key) return next();
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    if (m && safeEqual(m[1].trim(), key)) return next();
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: { message: "Invalid or missing API key" } });
  };
}
