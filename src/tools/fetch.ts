import { htmlToText } from "./net.js";
import type { ToolDef } from "./index.js";

/**
 * Fetch a page or an API response. Only the hosts a game lists are reachable (config.json: tools.fetch.hosts), over https, with size and time limits,
 * never a private address. Options: hosts (required), methods (default ["GET"]), max_bytes (200000), timeout_ms (8000).
 */
const fetchTool: ToolDef = {
  name: "fetch",
  description: "Fetch a web page or JSON API from an allowed host and return its text. Use only when you need exact or current facts.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full https URL on an allowed host." },
      method: { type: "string", enum: ["GET", "HEAD"], description: "Default GET." },
    },
    required: ["url"],
  },
  network(options) {
    const hosts = Array.isArray(options.hosts) ? options.hosts.filter((h: unknown): h is string => typeof h === "string") : [];
    return hosts.length ? { hosts, methods: Array.isArray(options.methods) && options.methods.length ? options.methods : ["GET"], maxBytes: Number(options.max_bytes) || 200_000, allowHttp: options.allow_http === true } : null;
  },
  async run(args, ctx) {
    if (!ctx.options.hosts?.length) throw new Error("this game allows no hosts for fetch");
    const url = String(args?.url ?? "");
    const r = await ctx.http(url, { method: args?.method === "HEAD" ? "HEAD" : "GET" });
    const text = /html/i.test(r.contentType) ? htmlToText(r.text) : r.text;
    return { url: r.url, status: r.status, content_type: r.contentType, truncated: r.truncated, text };
  },
};
export default fetchTool;
