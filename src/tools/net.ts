import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { HttpResult } from "./index.js";

/**
 * The one way tools reach the network. Built on node:http(s) so the address that is actually connected to can be checked (a name that resolves to
 * a private address is refused even if the name is allowed). Limits: allowed hosts, https only, methods, redirects (each hop checked again), size
 * and time. What comes back is untrusted data: the engine wraps it as such before the model sees it.
 */

export interface NetPolicy {
  /** Exact host names, or "*.example.com" for any subdomain. */
  hosts: string[];
  methods?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Allow plain http (default: https only). */
  allowHttp?: boolean;
  /** Allow loopback, private and link-local addresses (an operator-configured local service such as a self-hosted search engine). */
  allowPrivate?: boolean;
}

export class NetError extends Error {}

export function hostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return hosts.some((p) => { const x = p.toLowerCase(); return x.startsWith("*.") ? h.endsWith(x.slice(1)) && h.length > x.length - 1 : h === x; });
}

/** True for addresses that must not be reached from a tool: loopback, private, link-local, CGNAT, multicast, unspecified, unique-local IPv6. */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) { const tail = x.slice(7); return net.isIP(tail) === 4 ? isPrivateAddress(tail) : true; }
    return x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
  }
  return true; // not an address at all
}

const TEXTY = /^(text\/|application\/(json|xml|xhtml|x-ndjson|ld\+json)|application\/[a-z.+-]*\+(json|xml))/i;

function once(url: URL, p: Required<Pick<NetPolicy, "maxBytes" | "timeoutMs">> & NetPolicy, method: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const lookup: net.LookupFunction = (host, opts, cb) => {
      dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
        if (err) return cb(err, "", 0);
        const list = addrs as dns.LookupAddress[];
        const bad = !p.allowPrivate && list.find((a) => isPrivateAddress(a.address));
        if (bad) return cb(new NetError(`${host} resolves to a private address (${bad.address}); refused`) as NodeJS.ErrnoException, "", 0);
        if ((opts as any).all) return (cb as any)(null, list);
        cb(null, list[0].address, list[0].family);
      });
    };
    const req = lib.request(url, { method, headers: { "user-agent": "imeng-tool/1", accept: "application/json, text/*;q=0.9", ...headers }, lookup, timeout: p.timeoutMs }, (res) => {
      const chunks: Buffer[] = []; let size = 0, truncated = false;
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > p.maxBytes) { chunks.push(c.subarray(0, c.length - (size - p.maxBytes))); truncated = true; res.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }); return; }
        chunks.push(c);
      });
      res.on("end", () => { if (!truncated) resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }); });
      res.on("error", (e) => { if (!truncated) reject(e); });
    });
    req.on("timeout", () => req.destroy(new NetError(`timed out after ${p.timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

export async function guardedFetch(rawUrl: string, policy: NetPolicy, init: { method?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  const p = { ...policy, maxBytes: policy.maxBytes ?? 200_000, timeoutMs: policy.timeoutMs ?? 8000 };
  const method = (init.method || "GET").toUpperCase();
  if (!(p.methods ?? ["GET"]).includes(method)) throw new NetError(`method ${method} is not allowed (allowed: ${(p.methods ?? ["GET"]).join(", ")})`);
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new NetError(`not a valid URL: ${rawUrl.slice(0, 100)}`); }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && !(p.allowHttp && url.protocol === "http:")) throw new NetError(`only https is allowed (got ${url.protocol.replace(":", "")})`);
    if (url.username || url.password) throw new NetError("URLs with credentials are not allowed");
    if (!hostAllowed(url.hostname, p.hosts)) throw new NetError(`host ${url.hostname} is not allowed (allowed: ${p.hosts.join(", ") || "none"})`);
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !p.allowPrivate && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new NetError(`${url.hostname} is a private address; refused`);
    const r = await once(url, p, method, init.headers ?? {});
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      if (hop >= (p.maxRedirects ?? 3)) throw new NetError("too many redirects");
      url = new URL(String(r.headers.location), url); // checked again at the top of the loop
      continue;
    }
    const contentType = String(r.headers["content-type"] ?? "");
    if (contentType && !TEXTY.test(contentType)) throw new NetError(`content type ${contentType.split(";")[0]} is not text or JSON; refused`);
    return { status: r.status, contentType: contentType.split(";")[0], text: r.body.toString("utf8"), url: url.toString(), truncated: r.truncated };
  }
}

/** Visible text of an HTML page (scripts, styles and tags removed): enough for a model to read, nothing it could execute. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
