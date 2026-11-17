import type { ToolContext, ToolDef } from "./index.js";

/**
 * Movie and TV facts from The Movie Database (api.themoviedb.org): free for non-commercial use with a key (tools.config.mjs: tmdb.apiKey, or
 * tmdb.readToken for the v4 read token) and attribution. "Which actor was in every movie of a franchise" is answered by set logic in code
 * (cast_overlap), not by the model. Options in config.json: max_movies (12, how many films cast_overlap compares), top_cast (15).
 */
const BASE = "https://api.themoviedb.org/3";
export const ATTRIBUTION = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

async function api(ctx: ToolContext, route: string, query: Record<string, string | number> = {}): Promise<any> {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const headers: Record<string, string> = {};
  if (ctx.secrets.readToken) headers.authorization = `Bearer ${ctx.secrets.readToken}`;
  else if (ctx.secrets.apiKey) qs.set("api_key", String(ctx.secrets.apiKey));
  else throw new Error("tmdb is not configured: set tmdb.apiKey (or tmdb.readToken) in tools.config.mjs");
  const r = await ctx.http(`${BASE}${route}?${qs}`, { headers });
  if (r.status === 401) throw new Error("TMDB rejected the key");
  if (r.status === 404) throw new Error("TMDB has nothing at that id");
  if (r.status >= 400) throw new Error(`TMDB answered HTTP ${r.status}`);
  try { return JSON.parse(r.text); } catch { throw new Error("TMDB did not answer with JSON"); }
}

const year = (d?: string): number | null => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);
const movieRow = (m: any) => ({ id: m.id, title: m.title, year: year(m.release_date), url: `https://www.themoviedb.org/movie/${m.id}` });

async function cast(ctx: ToolContext, movieId: number): Promise<{ id: number; name: string; character: string }[]> {
  const j = await api(ctx, `/movie/${movieId}/credits`);
  return (j.cast ?? []).map((c: any) => ({ id: c.id, name: c.name, character: c.character ?? "" }));
}

const tmdb: ToolDef = {
  name: "tmdb",
  description: "Movie facts from TMDB: search a title, get its cast, list a franchise's films, find actors in all of a franchise's films, or a person's films.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search_movie", "credits", "collection", "cast_overlap", "person_movies"] },
      query: { type: "string", description: "Title, franchise or person name (search_movie, collection, person_movies)." },
      year: { type: "integer", description: "Release year, to narrow search_movie." },
      movie_id: { type: "integer", description: "TMDB movie id (credits)." },
      collection_id: { type: "integer", description: "TMDB collection id (cast_overlap)." },
      movie_ids: { type: "array", items: { type: "integer" }, description: "Movie ids to compare (cast_overlap), when there is no collection." },
    },
    required: ["action"],
  },
  network: () => ({ hosts: ["api.themoviedb.org"], maxBytes: 400_000 }),
  async run(args, ctx) {
    const top = Math.max(3, Math.min(40, Number(ctx.options.top_cast) || 15));
    const out = (o: object) => ({ ...o, attribution: ATTRIBUTION });
    switch (args?.action) {
      case "search_movie": {
        if (!args.query) throw new Error("query is required");
        const j = await api(ctx, "/search/movie", { query: String(args.query).slice(0, 200), ...(args.year ? { year: Number(args.year) } : {}) });
        return out({ results: (j.results ?? []).slice(0, 6).map((m: any) => ({ ...movieRow(m), overview: String(m.overview ?? "").slice(0, 160) })) });
      }
      case "credits": {
        const id = Number(args.movie_id);
        if (!Number.isInteger(id)) throw new Error("movie_id is required");
        const j = await api(ctx, `/movie/${id}/credits`);
        return out({ movie_id: id, director: (j.crew ?? []).filter((c: any) => c.job === "Director").map((c: any) => c.name), cast: (j.cast ?? []).slice(0, top).map((c: any) => ({ name: c.name, character: c.character ?? "" })) });
      }
      case "collection": {
        if (!args.query) throw new Error("query is required");
        const s = await api(ctx, "/search/collection", { query: String(args.query).slice(0, 200) });
        const found = (s.results ?? [])[0];
        if (!found) return out({ collection: null, movies: [] });
        const c = await api(ctx, `/collection/${found.id}`);
        const movies = (c.parts ?? []).map(movieRow).sort((a: any, b: any) => (a.year ?? 9999) - (b.year ?? 9999)); // unreleased last
        return out({ collection: { id: found.id, name: c.name ?? found.name }, movies });
      }
      case "cast_overlap": {
        const cap = Math.max(2, Math.min(25, Number(ctx.options.max_movies) || 12));
        let ids: number[] = Array.isArray(args.movie_ids) ? args.movie_ids.map(Number).filter(Number.isInteger) : [];
        let named: { id: number; title: string }[] = [];
        if (!ids.length && args.collection_id) {
          const c = await api(ctx, `/collection/${Number(args.collection_id)}`);
          named = (c.parts ?? []).filter((m: any) => m.release_date).sort((a: any, b: any) => String(a.release_date).localeCompare(String(b.release_date))).map((m: any) => ({ id: m.id, title: m.title }));
          ids = named.map((m) => m.id);
        }
        if (ids.length < 2) throw new Error("give a collection_id, or at least two movie_ids");
        const truncated = ids.length > cap;
        ids = ids.slice(0, cap);
        const casts = await Promise.all(ids.map((id) => cast(ctx, id)));
        const tally = new Map<number, { name: string; in: number; roles: string[] }>();
        casts.forEach((list) => {
          const seen = new Set<number>();
          for (const p of list) if (!seen.has(p.id)) { seen.add(p.id); const t = tally.get(p.id) ?? { name: p.name, in: 0, roles: [] }; t.in++; if (t.roles.length < 3 && p.character && !t.roles.includes(p.character)) t.roles.push(p.character); tally.set(p.id, t); }
        });
        const rows = [...tally.entries()].map(([id, t]) => ({ id, ...t })).sort((a, b) => b.in - a.in || a.name.localeCompare(b.name));
        return out({
          movies: ids.map((id) => ({ id, title: named.find((m) => m.id === id)?.title })),
          compared: ids.length, truncated,
          in_every_movie: rows.filter((r) => r.in === ids.length).map((r) => ({ name: r.name, roles: r.roles })),
          in_all_but_one: rows.filter((r) => r.in === ids.length - 1).slice(0, 10).map((r) => r.name),
        });
      }
      case "person_movies": {
        if (!args.query) throw new Error("query is required");
        const s = await api(ctx, "/search/person", { query: String(args.query).slice(0, 200) });
        const p = (s.results ?? [])[0];
        if (!p) return out({ person: null, movies: [] });
        const c = await api(ctx, `/person/${p.id}/movie_credits`);
        const movies = (c.cast ?? []).map((m: any) => ({ ...movieRow(m), character: m.character ?? "", popularity: m.popularity ?? 0 })).sort((a: any, b: any) => b.popularity - a.popularity).slice(0, 15).map(({ popularity: _p, ...m }: any) => m);
        return out({ person: { id: p.id, name: p.name }, movies });
      }
      default: throw new Error("action must be search_movie, credits, collection, cast_overlap or person_movies");
    }
  },
};
export default tmdb;
