import type { ToolDef } from "./index.js";

/**
 * Web search. The provider is the operator's choice, set in tools.config.mjs (not config.json), so a game can use a self-hosted SearXNG or a keyed API:
 *   { web_search: { provider: "searxng", url: "http://localhost:8080" } }
 *   { web_search: { provider: "brave", apiKey: "..." } }
 *   { web_search: { provider: "google_cse", apiKey: "...", cx: "..." } }
 * Options in config.json: max_results (5).
 */
const BRAVE = "https://api.search.brave.com/res/v1/web/search";
const GOOGLE = "https://www.googleapis.com/customsearch/v1";

const hostOf = (u: string): string => { try { return new URL(u).hostname; } catch { return ""; } };

const search: ToolDef = {
  name: "web_search",
  description: "Search the web and get titles, links and snippets. Use for current facts; then use the snippets, never guess.",
  parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"] },
  network(_options, secrets) {
    if (secrets.provider === "searxng" && secrets.url) { const h = hostOf(secrets.url); return h ? { hosts: [h], allowPrivate: true, allowHttp: secrets.url.startsWith("http:") } : null; } // the operator's own service
    if (secrets.provider === "brave") return { hosts: ["api.search.brave.com"] };
    if (secrets.provider === "google_cse") return { hosts: ["www.googleapis.com"] };
    return null;
  },
  async run(args, ctx) {
    const q = String(args?.query ?? "").trim().slice(0, 300);
    if (!q) throw new Error("query is empty");
    const n = Math.max(1, Math.min(10, Number(args?.count) || Number(ctx.options.max_results) || 5));
    const s = ctx.secrets;
    let url: string, headers: Record<string, string> = {};
    if (s.provider === "searxng" && s.url) url = `${String(s.url).replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(q)}`;
    else if (s.provider === "brave" && s.apiKey) { url = `${BRAVE}?q=${encodeURIComponent(q)}&count=${n}`; headers = { "x-subscription-token": String(s.apiKey) }; }
    else if (s.provider === "google_cse" && s.apiKey && s.cx) url = `${GOOGLE}?key=${encodeURIComponent(s.apiKey)}&cx=${encodeURIComponent(s.cx)}&q=${encodeURIComponent(q)}&num=${Math.min(n, 10)}`;
    else throw new Error("web_search is not configured: set a provider in tools.config.mjs (searxng, brave or google_cse)");
    const r = await ctx.http(url, { headers });
    if (r.status >= 400) throw new Error(`the search service answered HTTP ${r.status}`);
    let j: any;
    try { j = JSON.parse(r.text); } catch { throw new Error("the search service did not answer with JSON"); }
    const rows: any[] = s.provider === "searxng" ? j.results : s.provider === "brave" ? j.web?.results : j.items;
    const results = (Array.isArray(rows) ? rows : []).slice(0, n).map((x) => ({
      title: String(x.title ?? "").slice(0, 200),
      url: String(x.url ?? x.link ?? ""),
      snippet: String(x.content ?? x.description ?? x.snippet ?? "").replace(/<[^>]+>/g, "").slice(0, 400),
    }));
    return { query: q, provider: s.provider, results };
  },
};
export default search;
