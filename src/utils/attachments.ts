import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bucketOn, bucketPutFile } from "./bucket.js";
import { stateDb } from "./db-state.js";
import { dbg } from "./debug.js";
import { MODEL_ID } from "./config.js";
import type { ChatMessage } from "./types.js";

/**
 * Files people attach to a message (an image Open WebUI sends as a data: URI in an image_url part, or one a bridge hands over) that did not come from us.
 * Each is kept: staged in `_cache/` (ATTACH_CACHE_DIR), piped into the bucket, and recorded in the `attachments` table (which message, chat, thread, person).
 * The message then carries a placeholder `[image:<id>]` instead of the bytes: no model, log or trace ever holds the file. The id is the file's hash, so
 * Open WebUI sending the same history again on every request stores nothing twice. Nothing here ever throws into a game: a failure is logged and the file is
 * simply not kept. Active only when there is somewhere to put the file (a bucket or a database) and ATTACH_CAPTURE is not "off".
 */
const log = dbg("bucket");
export const ATTACH_DIR = (): string => path.resolve(process.env.ATTACH_CACHE_DIR || "./_cache");
const MAX = (): number => Number(process.env.ATTACH_MAX_BYTES || 15 * 1024 * 1024);
const TTL_MS = (): number => Number(process.env.ATTACH_TTL_DAYS || 30) * 86_400_000;
export const attachActive = (): boolean => process.env.ATTACH_CAPTURE !== "off" && (bucketOn() || !!stateDb());

export interface AttachCtx { session: string; userId?: string; thread?: string; messageIndex?: number; turn?: number; source: "openwebui" | "discord" | "other" }
export interface Saved { id: string; sha256: string; mime: string; bytes: number; bucketKey: string | null; cached: boolean }

const DATA = /^data:([^;,]+)((?:;[^;,=]+=[^;,]+)*)(;base64)?,([\s\S]*)$/;
export function parseDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  const m = DATA.exec(uri);
  if (!m) return null;
  try { return { mime: m[1].toLowerCase(), bytes: m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4])) }; } catch { return null; }
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "none";

/** Keep one file. Returns what was stored, or null when it was refused (too big, empty) or could not be kept. */
export async function captureBytes(bytes: Buffer, mime: string, ctx: AttachCtx, now = Date.now()): Promise<Saved | null> {
  if (!bytes.length || bytes.length > MAX()) { log("refused attachment of %d bytes", bytes.length); return null; }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const id = sha256.slice(0, 24);
  const key = `uploads/${safe(ctx.session)}/${id}`;
  let cached = false, stored = false;
  const file = path.join(ATTACH_DIR(), `${safe(ctx.session)}-${id}`);
  try {
    fs.mkdirSync(ATTACH_DIR(), { recursive: true });
    fs.writeFileSync(file + ".part", bytes); fs.renameSync(file + ".part", file); cached = true;
    if (bucketOn()) { stored = await bucketPutFile(key, file, mime); if (stored) { fs.rmSync(file, { force: true }); cached = false; } }
  } catch (e) { console.warn(`attachment ${id} could not be staged: ${(e as Error).message}`); }
  const db = stateDb();
  if (db) {
    try {
      await db.insertInto("attachments").values({ session: ctx.session, id, game: MODEL_ID, user_id: ctx.userId ?? null, thread: ctx.thread ?? null, message_index: ctx.messageIndex ?? null, turn: ctx.turn ?? null, source: ctx.source, sha256, mime, bytes: bytes.length, bucket_key: stored ? key : null, cached: cached ? 1 : 0, created_at: now, expires_at: now + TTL_MS() })
        .onConflict((oc) => oc.columns(["session", "id"]).doNothing()).execute();
    } catch (e) { console.warn(`attachment ${id} could not be recorded: ${(e as Error).message}`); }
  }
  if (!cached && !stored && !db) return null;
  log("kept %s (%s, %d bytes) bucket=%s cached=%s", id, mime, bytes.length, stored, cached);
  return { id, sha256, mime, bytes: bytes.length, bucketKey: stored ? key : null, cached };
}

/** Replace every attached data: image in the messages with `[image:<id>]`, keeping each file. Messages without images come back unchanged. */
export async function captureAttachments(messages: ChatMessage[], ctx: Omit<AttachCtx, "messageIndex" | "turn">): Promise<{ messages: ChatMessage[]; saved: Saved[] }> {
  const saved: Saved[] = [];
  if (!attachActive()) return { messages, saved };
  let turn = 0;
  const out: ChatMessage[] = [];
  for (const [i, m] of messages.entries()) {
    if (m.role === "user") turn++;
    if (!Array.isArray(m.content) || m.role !== "user") { out.push(m); continue; }
    let changed = false;
    const parts: unknown[] = [];
    for (const p of m.content as { type?: string; image_url?: { url?: string } | string }[]) {
      const uri = p?.type === "image_url" ? (typeof p.image_url === "string" ? p.image_url : p.image_url?.url) : undefined;
      const parsed = uri ? parseDataUri(uri) : null;
      if (!parsed) { parts.push(p); continue; }
      const s = await captureBytes(parsed.bytes, parsed.mime, { ...ctx, messageIndex: i, turn });
      if (s) { saved.push(s); parts.push({ type: "text", text: `[image:${s.id}]` }); changed = true; } else parts.push(p);
    }
    out.push(changed ? { ...m, content: parts as never } : m);
  }
  return { messages: out, saved };
}
