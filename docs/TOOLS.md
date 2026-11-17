# TOOLS.md

Tools let the narrator fetch facts instead of guessing: stock data, movie casts, web search, a page from an allowed host. They use the standard **OpenAI-style function calling** that Ollama's OpenAI-compatible API supports for tool-capable models (`ollama show <model>` lists `tools` under Capabilities; gemma4 does). Everything a tool may do is bounded **in code**, and a game opts in to each tool in `config.json`.

## How a turn works with tools
1. The narrator is offered the tools the game lists (name, short description, JSON Schema) and a notice that tool results are untrusted data.
2. It may call tools (up to `tool_rounds` model-and-tool rounds a turn). Each call is checked, run, cut to a size, logged, and returned as `{"tool":"...","untrusted":true,"result":...}` (or `{"error":...}`: a failing tool is reported to the narrator, never to the player).
3. When the narrator answers, that answer is the turn's narration. If it needed no tool, there is **one** model call, as without tools. The answer reaches the player as one piece (a tool turn is not streamed word by word); if the rounds run out, the final answer is written without tools and streamed.
4. Tool calls appear in the model log as `tool:<name>` and in MLflow as `tool.call` spans.

## Where things are set
| What | Where | Why |
|---|---|---|
| Which tools a game may use, and their limits | `config.json` `tools` (and `tool_rounds`) | committed with the game; the allowlist |
| Keys, endpoints, providers | `tools.config.mjs` (start from `tools.config.example.mjs`; `TOOLS_CONFIG` for another path; `.json` works too) | secrets: **keep it out of git** (add `tools.config.mjs` to `.gitignore`) |
| What a tool is and does | `tools/<name>.ts`, listed in `src/tools/index.ts` | one module per tool |

```json
"tools": {
  "tmdb":       { "max_calls_per_turn": 4, "top_cast": 12, "max_movies": 8 },
  "web_search": { "max_results": 4 },
  "fetch":      { "hosts": ["api.example.com"], "methods": ["GET"], "max_bytes": 200000 },
  "stock":      { "timezone": "America/New_York", "rate": 0.045 }
},
"tool_rounds": 3
```
Every tool also takes `max_calls_per_turn` (3), `max_chars` (6000: a result is cut to this), `timeout_ms` (15000). Unknown tool names, and tools that cannot work as configured (a `fetch` without hosts, a search with no provider), are skipped with a warning at the first use.

## Built-in tools
| Tool | What it does | Needs |
|---|---|---|
| `fetch` | a page or JSON API from an **allowed host** (HTML reduced to text) | `tools.fetch.hosts` in config.json (options: `methods`, `max_bytes`, `timeout_ms`, `allow_http`) |
| `web_search` | titles, links and snippets from SearXNG, Brave or Google CSE | a provider in `tools.config.mjs` |
| `tmdb` | movies and TV from TMDB: search, credits, a franchise's films, **`cast_overlap`** (who is in every film: set logic in code), a person's films | a free key in `tools.config.mjs`; TMDB's credit line is in every result (`attribution`) |
| `stock` | quotes, history, news, options (Yahoo, `yahoo-finance2`), **a time-travel clock**, picks and a journal | `npm install` (no key) |

There is no official free IMDb API (the official one is a paid data service), so film facts come from TMDB, which carries IMDb ids and is free for non-commercial use with attribution.

### Network safety (`src/tools/net.ts`)
A tool reaches the network only through the client the engine binds to its policy: https only (unless allowed), the host must be on the list (exact or `*.domain`), methods and size and time are limited, redirects are re-checked at every hop, no credentials in URLs, only text or JSON comes back, and **private, loopback, link-local and similar addresses are refused by checking the address actually connected to** (so a name that resolves to one is refused too). The one deliberate exception: a self-hosted SearXNG on the operator's own machine, whose URL comes from `tools.config.mjs`, not from the game or the model. Results are untrusted data; the narrator is told so.

### The stock tool: the economic calendar, the Vibe Trader's read and the checks
- `calendar` (`symbol`, `date` optional): the day's events from a file you keep (`tools.stock.calendar_file`, default none; or `calendar` inline), as `{"events":[{"date":"2026-11-09","time":"08:30","event":"CPI","impact":"high","note":""}]}` with times in the game's timezone, plus the pitfalls for the morning (anything before the open, anything before `warn_until` (default 11:30), every high-impact event) and the symbol's earnings date from Yahoo. Yahoo has no economic calendar, so the file is yours to update; the tool says so when it holds nothing within a week of the date. MarketWatch and other calendars are not read by the engine: copy events into the file, or allow a host in a `fetch` tool.
- `vibe` (`symbol`): the Vibe Trader's chart read, all computed in code (`src/tools/ta.ts`, `src/tools/vibe.ts`) from closed 15-minute candles of regular hours only: the session's swing, an entry line (a 0.618 retracement, `vibe.entry_fib`), fib 1/2/3 targets (1.0, 1.618, 2.618 extensions of the swing), the hold (price pulled back to the line, then `vibe.hold` (3) closes on the right side of it), OBV now against OBV when the signal formed (lower = a leading warning of a dump), Bollinger 20/2, Stochastic 14/3/3 and the PCO (a port of the TradingView Price Clouds Oscillator: presets `Fast`, `Slow` (default), `Super Slow` as `vibe.pco_preset`; the cross is the fast over the slow line). The verdict is one of `setup_ready`, `setup_mixed` (names who disagrees), `waiting_for_pullback`, `waiting_for_hold`, `avoid_obv_warns_of_dump`, `no_swing`, `not_enough_data`. The fib anchor is the session's lowest low to highest high (up if the low came first, else down and mirrored).
- `require_checks` (`["news","calendar"]`, default none): `vibe` and `pick` are refused until the news for that symbol (within `check_turns`, default 2 turns) and the day's calendar were fetched, so "check the news first" is enforced by the tool, not by the prompt.
- Time travel applies: bars are cut at the clock, so the read is what Vibe would have seen. Not verified against TradingView: the PCO and the other indicators are tested for internal consistency, not compared with a chart.

### The stock tool and time travel
`set_clock` puts the tool at a past moment ("2026-11-02T08:00" in the game's timezone). From then on **every** data call is cut off at that moment in code: bars, quotes and headlines later than it are dropped even if Yahoo returns them. The clock can be moved back but never forward; the only way to see what happened next is `reveal` on a recorded pick, which is refused in the turn the pick was made and clears the clock. The journal keeps right and wrong and a hit rate (also in the game's state, for the narrator's memory).

Limits you should know:
- Yahoo keeps **1-minute bars for about 7 days and 5-minute bars for about 60 days**; older moments only have daily bars.
- Yahoo has **no historical option prices.** In time travel the chain is a Black-Scholes model at that moment's price with an assumed volatility (yours, or the realised one from the days before), and a reveal prices entry and exit the same way: the underlying's move and time decay count, volatility changes do not. Every result says "modeled". Live (no clock) the chain is Yahoo's real one, with delta computed from each option's implied volatility.
- Past headlines are only what Yahoo still lists.
- Not run against the live Yahoo yet: the logic is tested with a fake one (`tests/tools-stock.test.ts`).

### The db tool

Read-only questions to the bookkeeping database (needs `DATABASE_URL`, DEPLOYMENT.md). The model never writes SQL: it gives a table, columns, `where` filters (`eq ne gt gte lt lte like in`), `order_by` and `limit`, or asks for a `count`. `config.json` lists what is readable: `{"tools":{"db":{"tables":{"players":{"columns":["user_id","name","seen_at"],"filter":["user_id"],"pii":["name"]}},"max_rows":20,"timeout_ms":2000}}}`. Only listed tables and columns can be read; only `filter` columns can be searched (default: the listed columns); `pii` columns come back masked (`pii_mask`); rows past their `expires_at` are never returned; rows and time are capped (100 rows at most). Review any new query against the execution plan.

## Adding a tool
1. `tools/<name>.ts` default-exports a `ToolDef`: `name`, a short `description` (every schema costs context), `parameters` (JSON Schema), optional `network(options, secrets)` returning the policy (hosts and limits) or null, and `run(args, ctx)`. `ctx` gives the turn, the state (read only), `options` (config.json), `secrets` (tools.config.mjs), `http` (bound to the policy), `store` (state saved with the session) and `now()`. Return data, or throw an `Error`: the message goes to the narrator.
2. Add it to `REGISTRY` in `src/tools/index.ts` (loaded lazily, so an unused tool's dependencies are never required).
3. Prefer one tool with an `action` argument over many tools: fewer schemas, less context.
4. Test it with `tests/tool-ctx.ts` (a scripted `http`, an in-memory store, a fixed clock). Use Node's own `fetch`/`http` and standard packages; do not invent protocols.
5. If it needs something to run (a service, an API key, Python), the **game** says how to start it in its own `README.md`. If you need Python, use a virtual environment and write down how to run it by hand (`python -m venv .venv`, `pip install -r requirements.txt`, the command). Expensive resources (a GPU image model) should be started only when needed.

## Not built yet
Image generation (a `generate_image` tool with a provider you choose in `config.json`: an OpenAI-compatible `/v1/images/generations` or an AUTOMATIC1111 `/sdapi/v1/txt2img`), and a GPU lease so that, outside production, the judge does not hold the GPU while an image model runs. MCP servers as a second tool source. Waiting for a free narrator model before a turn.
