// Copy to tools.config.mjs and fill in what you use. tools.config.mjs holds secrets: keep it OUT of git (add it to .gitignore).
// It is read by the proxy (TOOLS_CONFIG=/path/to/file to use another location). Each key is a tool name; which tools a game may use at all is
// decided by its config.json ("tools"), never by this file. Missing tools or keys just make that tool unavailable.
export default {
  // Movie and TV facts. A free key: https://www.themoviedb.org/settings/api
  // Use readToken (the "API Read Access Token") instead of apiKey if you prefer a Bearer token.
  tmdb: {
    apiKey: "YOUR_TMDB_V3_KEY",
    // readToken: "YOUR_TMDB_V4_READ_TOKEN",
  },

  // Web search: pick ONE provider.
  web_search: {
    // A SearXNG you run (free, no key): docker run -d -p 8080:8080 searxng/searxng  (enable the json format in its settings.yml)
    provider: "searxng",
    url: "http://localhost:8080",
    // provider: "brave",      apiKey: "YOUR_BRAVE_SEARCH_KEY",
    // provider: "google_cse", apiKey: "YOUR_GOOGLE_KEY", cx: "YOUR_SEARCH_ENGINE_ID",
  },

  // The stock tool needs nothing here: yahoo-finance2 uses Yahoo's public endpoints. Its options (timezone, rate,
  // max_rows) are in the game's config.json.
  // stock: {},

  // fetch needs nothing here either: the hosts it may reach are listed in the game's config.json (tools.fetch.hosts).
};
