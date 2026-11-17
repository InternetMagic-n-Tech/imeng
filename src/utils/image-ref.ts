import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import { gameFile, IMAGE_MAX_BYTES, IMAGE_REF_ALLOW_PRIVATE, IMAGE_TIMEOUT_MS } from "./image-config.js";
import { sniff, usable } from "./image-format.js";
import { readImage, BadImage } from "./image-store.js";
import { screen } from "./image-safety.js";
import type { ImageKind } from "./image-format.js";

/** A reference picture: a file in the game folder, a stored picture, a data: URI (a picture attached in the chat) or, when allowed, an http(s) URL. */

export interface Ref { bytes: Buffer; kind: ImageKind }
export interface RefIO { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]>; allowUrls?: boolean; allowPrivate?: boolean }

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

const defaultLookup = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true })).map((a) => a.address);

function checked(bytes: Buffer): Ref {
  if (bytes.length > IMAGE_MAX_BYTES) throw new BadImage("too_big");
  const kind = sniff(bytes);
  if (!usable(kind)) throw new BadImage(kind);
  return { bytes, kind };
}

/** A picture from outside the game folder (attached or fetched) is also run through the content check. */
async function screened(bytes: Buffer): Promise<Ref> {
  const r = checked(bytes);
  await screen(r.bytes, "upload");
  return r;
}

export async function loadReference(spec: string, io: RefIO = {}): Promise<Ref> {
  const s = spec.trim();
  const data = /^data:[^;,]*;base64,(.*)$/s.exec(s);
  if (data) return screened(Buffer.from(data[1], "base64"));
  if (/^https?:\/\//i.test(s)) {
    if (!io.allowUrls) throw new Error("reference URLs are not allowed in this game");
    const url = new URL(s);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [host] : await (io.lookup ?? defaultLookup)(host);
    if (!(io.allowPrivate ?? IMAGE_REF_ALLOW_PRIVATE) && addrs.some(isPrivateIp)) throw new Error("reference URL points at a private address");
    const r = await (io.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(Math.min(IMAGE_TIMEOUT_MS, 30000)) });
    if (!r.ok) throw new Error(`reference URL answered ${r.status}`);
    const len = Number(r.headers.get("content-length"));
    if (Number.isFinite(len) && len > IMAGE_MAX_BYTES) throw new BadImage("too_big");
    return screened(Buffer.from(await r.arrayBuffer()));
  }
  const stored = readImage(s);
  if (stored) return checked(stored.bytes);
  const file = gameFile(s);
  if (!file) throw new Error("reference file is outside the game folder");
  return checked(fs.readFileSync(file));
}
