import { bs, realizedVol } from "./bs.js";
import type { Side } from "./bs.js";
import { dayBrief, readEvents } from "./calendar.js";
import { VIBE_DEFAULTS, vibeRead } from "./vibe.js";
import { IMENG_PATH } from "../utils/config.js";
import type { PcoPreset } from "./ta.js";
import type { ToolContext, ToolDef } from "./index.js";

/**
 * Stock data, news and option ideas from Yahoo Finance (the `yahoo-finance2` package), with a TIME TRAVEL clock.
 *
 * Time travel: set_clock puts the tool at a past moment ("8am Monday last week"). From then on EVERY data call is cut off at that moment in code,
 * not by asking the model to behave: bars, quotes and news after it are never returned. The clock can be moved back but not forward; the only way
 * to see what happened next is `reveal` on a pick, which is refused in the turn the pick was made. After a reveal the clock is cleared.
 *
 * Options: Yahoo has no historical option prices. In time travel the chain is MODELED (Black-Scholes at the spot of that moment, an assumed or realised
 * volatility), and a reveal prices the option at entry and exit with the same assumption (so time decay and the underlying's move count, volatility
 * changes do not). Every result says so. Live (no clock), the chain is Yahoo's real one.
 *
 * Intraday history Yahoo keeps: 1 minute for about 7 days, 5 minutes for about 60 days; older moments only have daily bars.
 * config.json options: timezone ("America/New_York"), rate (0.045), max_rows (60).
 */

interface Bar { t: Date; o: number; h: number; l: number; c: number; v: number }
export interface Pick {
  id: string; turn: number; symbol: string; side: Side; position: "long" | "short"; strike: number; expiry: string;
  entry_at: string; exit_at: string; spot_at_entry: number; iv: number; modeled_entry: number; note?: string; live: boolean;
  revealed?: { spot_at_exit: number; modeled_exit: number; pnl_pct: number; underlying_move_pct: number; verdict: "right" | "wrong"; high: number; low: number };
}
export interface StockState { asOf?: string; picks: Pick[]; right: number; wrong: number; checks?: { news: Record<string, number>; calendar: Record<string, number> } }

// ---------- Yahoo (replaceable in tests) ----------
let yahoo: any = null;
export function setYahoo(y: unknown): void { yahoo = y; }
async function yf(): Promise<any> {
  if (yahoo) return yahoo;
  let mod: any;
  const name = "yahoo-finance2"; // not a literal: the package is optional, and only a game that uses this tool needs it
  try { mod = await import(/* @vite-ignore */ name); } catch { throw new Error("the stock tool needs the yahoo-finance2 package: npm install yahoo-finance2"); }
  const Cls = mod.default ?? mod;
  yahoo = typeof Cls === "function" ? new Cls({ suppressNotices: ["yahooSurvey"] }) : Cls;
  return yahoo;
}

// ---------- time ----------
const DAY = 86_400_000, YEAR = 365 * DAY;
function tzOffsetMs(d: Date, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime();
}
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off) t = guess - off2; // across a DST change
  return new Date(t);
}
/** "2026-11-02T08:00" or "2026-11-02 08:00" in `tz`, or an ISO string with an offset or Z. */
export function parseWhen(s: string, tz: string): Date {
  const str = String(s).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(str) && /T/.test(str)) { const d = new Date(str); if (!isNaN(+d)) return d; }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(str);
  if (!m) throw new Error(`could not read the time "${str}": use YYYY-MM-DDTHH:mm (local to ${tz})`);
  return zonedToUtc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, tz);
}
const localParts = (d: Date, tz: string) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value])); return { y: +p.year, m: +p.month, d: +p.day, wd: p.weekday as string, ymd: `${p.year}-${p.month}-${p.day}` }; };
const addDays = (ymd: string, n: number): string => { const t = new Date(ymd + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekday = (ymd: string): number => new Date(ymd + "T12:00:00Z").getUTCDay();
const iso = (d: Date): string => d.toISOString();
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

/** "0dte" (the day of `at`), "weekly" (the next Friday after it), "monthly" (the third Friday, this month or next) or a date: the expiry date as YYYY-MM-DD. */
export function resolveExpiry(spec: string, at: Date, tz: string): string {
  const today = localParts(at, tz).ymd;
  const s = String(spec || "0dte").toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === "0dte") { const wd = weekday(today); if (wd === 0 || wd === 6) throw new Error(`${today} is a weekend: the market is closed, so there is no 0DTE that day`); return today; }
  if (s === "weekly") { let d = addDays(today, 1); while (weekday(d) !== 5) d = addDays(d, 1); return d; }
  if (s === "monthly") {
    const third = (y: number, m: number): string => { let d = `${y}-${String(m).padStart(2, "0")}-01`; while (weekday(d) !== 5) d = addDays(d, 1); return addDays(d, 14); };
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const this_ = third(y, m);
    return this_ > today ? this_ : third(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
  }
  throw new Error(`expiry must be 0dte, weekly, monthly or a date (YYYY-MM-DD), not "${spec}"`);
}
const expiryInstant = (ymd: string, tz: string): Date => zonedToUtc(+ymd.slice(0, 4), +ymd.slice(5, 7), +ymd.slice(8, 10), 16, 0, tz); // the close

// ---------- state ----------
const st = (ctx: ToolContext): StockState => ctx.store.get<StockState>() ?? { picks: [], right: 0, wrong: 0 };
const tzOf = (ctx: ToolContext): string => String(ctx.options.timezone || "America/New_York");
const rateOf = (ctx: ToolContext): number => (Number.isFinite(Number(ctx.options.rate)) ? Number(ctx.options.rate) : 0.045);
const maxRows = (ctx: ToolContext): number => Math.max(5, Math.min(200, Number(ctx.options.max_rows) || 60));
const clockOf = (ctx: ToolContext): Date | null => { const s = st(ctx).asOf; return s ? new Date(s) : null; };
const symbolOf = (a: any): string => { const s = String(a?.symbol ?? "").toUpperCase().trim(); if (!/^[A-Z0-9.^=-]{1,12}$/.test(s)) throw new Error("symbol is required (like AAPL)"); return s; };

// ---------- data ----------
const INTRADAY_DAYS: Record<string, number> = { "1m": 7, "2m": 60, "5m": 60, "15m": 60, "30m": 60, "60m": 60, "1h": 60 };
async function bars(ctx: ToolContext, symbol: string, from: Date, to: Date, interval: string): Promise<Bar[]> {
  const lim = INTRADAY_DAYS[interval];
  if (lim && ctx.now() - +from > lim * DAY) throw new Error(`${interval} bars only go back about ${lim} days; for a moment that old use interval 1d`);
  const r = await (await yf()).chart(symbol, { period1: from, period2: new Date(+to + 1000), interval: interval === "1h" ? "60m" : interval, includePrePost: interval !== "1d" });
  const rows: any[] = r?.quotes ?? [];
  return rows.map((q) => ({ t: new Date(q.date), o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume ?? 0 }))
    .filter((b) => Number.isFinite(b.c) && b.c !== null && !isNaN(+b.t) && +b.t <= +to) // the cut-off is enforced here, whatever Yahoo returned
    .sort((a, b) => +a.t - +b.t);
}

interface Spot { price: number; at: Date; prev_close: number | null }
/** The price as of `at`: the last bar at or before it (pre-market included), and the previous day's close. */
async function spotAt(ctx: ToolContext, symbol: string, at: Date): Promise<Spot> {
  const tz = tzOf(ctx);
  const intra = await bars(ctx, symbol, new Date(+at - 6 * DAY), at, "5m").catch(async (e) => { if (/only go back/.test(e.message)) return [] as Bar[]; throw e; });
  const daily = await bars(ctx, symbol, new Date(+at - 25 * DAY), at, "1d");
  const day = localParts(at, tz).ymd;
  const before = daily.filter((b) => localParts(b.t, tz).ymd < day);
  const last = intra.at(-1) ?? before.at(-1);
  if (!last) throw new Error(`no price data for ${symbol} at ${iso(at)}`);
  return { price: last.c, at: last.t, prev_close: before.at(-1)?.c ?? null };
}
async function volAt(ctx: ToolContext, symbol: string, at: Date, given?: unknown): Promise<number> {
  const g = Number(given);
  if (Number.isFinite(g) && g > 0) return g > 3 ? g / 100 : g; // 35 or 0.35
  const daily = await bars(ctx, symbol, new Date(+at - 45 * DAY), at, "1d");
  const v = realizedVol(daily.slice(-21).map((b) => b.c));
  return Math.min(2, Math.max(0.1, v ?? 0.3));
}
const step = (spot: number): number => (spot < 25 ? 0.5 : spot < 200 ? 1 : spot < 500 ? 2.5 : 5);

// ---------- checks before a call: news and the calendar ----------
const mark = (ctx: ToolContext, kind: "news" | "calendar", key: string): void => {
  const s = st(ctx), c = s.checks ?? { news: {}, calendar: {} };
  ctx.store.set({ ...s, checks: { ...c, [kind]: { ...c[kind], [key]: ctx.turn } } });
};
/** With options.require_checks (["news","calendar"]), a read or a pick is refused until the news for that symbol (within check_turns turns, default 2) and the day's calendar have been looked at. */
function needChecks(ctx: ToolContext, symbol: string, ymd: string): void {
  const want: string[] = Array.isArray(ctx.options.require_checks) ? ctx.options.require_checks : [], c = st(ctx).checks, within = Math.max(0, Number(ctx.options.check_turns ?? 2));
  const missing: string[] = [];
  if (want.includes("news") && !(c?.news[symbol] !== undefined && ctx.turn - c.news[symbol] <= within)) missing.push(`news for ${symbol}`);
  if (want.includes("calendar") && c?.calendar[ymd] === undefined) missing.push(`the economic calendar for ${ymd}`);
  if (missing.length) throw new Error(`before any call on ${symbol}, check ${missing.join(" and ")} first (action ${missing.map((m) => (m.startsWith("news") ? "news" : "calendar")).join(", ")}), and tell the player what they showed`);
}
const minutesOf = (d: Date, tz: string): number => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value])); return Number(p.hour) * 60 + Number(p.minute); };

// ---------- the tool ----------
const TT_NOTE = "Time travel: nothing after as_of is visible.";
const stock: ToolDef = {
  name: "stock",
  description: "Stock quotes, history, news and option ideas (Yahoo Finance), with a time-travel clock for judging a call without hindsight, and a journal of picks.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["quote", "history", "news", "calendar", "vibe", "options", "set_clock", "clear_clock", "clock", "pick", "reveal", "journal"] },
      symbol: { type: "string" },
      when: { type: "string", description: "set_clock: local time YYYY-MM-DDTHH:mm in the game's timezone." },
      interval: { type: "string", enum: ["1d", "1h", "5m"], description: "history." },
      date: { type: "string", description: "calendar: YYYY-MM-DD (default: today, or the clock's day)." },
      days: { type: "integer", description: "history: how far back (1-60)." },
      count: { type: "integer", description: "news: how many headlines." },
      expiry: { type: "string", description: "options, pick: 0dte, weekly, monthly or YYYY-MM-DD." },
      side: { type: "string", enum: ["call", "put", "both"] },
      strike: { type: "number" },
      position: { type: "string", enum: ["long", "short"], description: "pick: default long (buy, then sell at exit_at)." },
      exit_at: { type: "string", description: "pick: local time to close the idea, YYYY-MM-DDTHH:mm." },
      iv: { type: "number", description: "Assumed implied volatility (0.35 or 35). Default: realised volatility." },
      strikes: { type: "integer", description: "options: strikes each side of the money (default 4)." },
      pick_id: { type: "string" },
      note: { type: "string", description: "pick: the reasoning, in a line." },
    },
    required: ["action"],
  },
  async run(a, ctx) {
    const tz = tzOf(ctx), s = st(ctx), save = (x: StockState) => ctx.store.set(x);
    const clock = clockOf(ctx);
    switch (a?.action) {
      case "clock": return { mode: clock ? "time_travel" : "live", as_of: clock ? iso(clock) : null, local: clock ? clock.toLocaleString("en-US", { timeZone: tz }) : null, timezone: tz };

      case "set_clock": {
        const when = parseWhen(String(a.when), tz);
        if (+when > ctx.now() - 60_000) throw new Error("the clock can only be set to a past moment");
        if (clock && +when > +clock) throw new Error("the clock can be moved back but not forward; the only way to see what happened next is reveal");
        save({ ...s, asOf: iso(when) });
        return { as_of: iso(when), local: when.toLocaleString("en-US", { timeZone: tz }), timezone: tz, note: `${TT_NOTE} Pre-market bars before as_of are visible. Intraday bars exist for about the last 60 days (1m: 7).` };
      }

      case "clear_clock": {
        const pending = s.picks.filter((p) => !p.revealed && !p.live);
        if (pending.length) throw new Error(`reveal ${pending.map((p) => p.id).join(", ")} first: clearing the clock would show the outcome without recording it`);
        save({ ...s, asOf: undefined });
        return { mode: "live" };
      }

      case "quote": {
        const symbol = symbolOf(a);
        if (clock) {
          const sp = await spotAt(ctx, symbol, clock);
          return { symbol, mode: "time_travel", as_of: iso(clock), price: r2(sp.price), bar_time: iso(sp.at), prev_close: sp.prev_close === null ? null : r2(sp.prev_close), change_pct_vs_prev_close: sp.prev_close ? r2(((sp.price - sp.prev_close) / sp.prev_close) * 100) : null, note: TT_NOTE };
        }
        const q = await (await yf()).quote(symbol);
        return { symbol, mode: "live", name: q.shortName ?? q.longName, price: q.regularMarketPrice, prev_close: q.regularMarketPreviousClose, change_pct: q.regularMarketChangePercent === undefined ? undefined : r2(q.regularMarketChangePercent), pre_market_price: q.preMarketPrice, market_state: q.marketState, currency: q.currency };
      }

      case "history": {
        const symbol = symbolOf(a), interval = a.interval === "1h" || a.interval === "5m" ? a.interval : "1d";
        const days = Math.max(1, Math.min(60, Number(a.days) || (interval === "1d" ? 30 : 3)));
        const to = clock ?? new Date(ctx.now());
        const rows = (await bars(ctx, symbol, new Date(+to - days * DAY), to, interval)).slice(-maxRows(ctx));
        return { symbol, interval, as_of: clock ? iso(clock) : null, bars: rows.map((b) => ({ t: interval === "1d" ? localParts(b.t, tz).ymd : iso(b.t), o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c), v: b.v })), ...(clock ? { note: TT_NOTE } : {}) };
      }

      case "news": {
        const symbol = symbolOf(a), n = Math.max(1, Math.min(15, Number(a.count) || 8));
        const r = await (await yf()).search(symbol, { newsCount: 25, quotesCount: 0 });
        const items = (r?.news ?? []).map((x: any) => ({ title: String(x.title ?? "").slice(0, 200), publisher: x.publisher, link: x.link, at: x.providerPublishTime instanceof Date ? x.providerPublishTime : new Date(Number(x.providerPublishTime) * (Number(x.providerPublishTime) < 1e12 ? 1000 : 1)) }))
          .filter((x: any) => !isNaN(+x.at) && (!clock || +x.at <= +clock))
          .sort((x: any, y: any) => +y.at - +x.at).slice(0, n)
          .map((x: any) => ({ title: x.title, publisher: x.publisher, published: iso(x.at), link: x.link }));
        mark(ctx, "news", symbol);
        return { symbol, as_of: clock ? iso(clock) : null, headlines: items, note: clock ? `${TT_NOTE} Only headlines Yahoo still lists can be shown, so older days may be thin.` : "Latest headlines Yahoo lists." };
      }

      case "calendar": {
        const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date ?? "")) ? String(a.date) : localParts(clock ?? new Date(ctx.now()), tz).ymd;
        const all = readEvents(ctx.options, IMENG_PATH), brief = dayBrief(all, ymd, String(ctx.options.warn_until || "11:30"));
        const near = all.some((e) => Math.abs(+new Date(e.date + "T12:00:00Z") - +new Date(ymd + "T12:00:00Z")) <= 7 * DAY);
        const earnings: string[] = [];
        if (a.symbol) {
          const symbol = symbolOf(a);
          try {
            const r = await (await yf()).quoteSummary(symbol, { modules: ["calendarEvents"] });
            for (const d of r?.calendarEvents?.earnings?.earningsDate ?? []) { const dd = new Date(d); if (!isNaN(+dd) && localParts(dd, tz).ymd === ymd) earnings.push(`${symbol} reports earnings today (${dd.toISOString()}).`); }
          } catch { /* Yahoo may not list it */ }
        }
        mark(ctx, "calendar", ymd);
        const file = ctx.options.calendar || ctx.options.calendar_file;
        return { date: ymd, timezone: tz, events: brief.events, pitfalls: [...brief.pitfalls, ...earnings], clear: brief.clear && !earnings.length, ...(!file ? { note: "No calendar is configured for this game (tools.stock.calendar_file), so an empty list means nothing was checked, not that the day is quiet." } : !near ? { note: "The calendar file has no events within a week of this date: it needs updating, so an empty list does not mean the day is quiet." } : {}) };
      }

      case "vibe": {
        const symbol = symbolOf(a), at = clock ?? new Date(ctx.now()), ymd = localParts(at, tz).ymd;
        needChecks(ctx, symbol, ymd);
        const o = ctx.options.vibe ?? {};
        const opt = { ...VIBE_DEFAULTS, hold: Number(o.hold) >= 1 ? Math.floor(Number(o.hold)) : VIBE_DEFAULTS.hold, entryFib: Number(o.entry_fib) > 0 && Number(o.entry_fib) < 1 ? Number(o.entry_fib) : VIBE_DEFAULTS.entryFib, preset: (["Fast", "Slow", "Super Slow"].includes(o.pco_preset) ? o.pco_preset : VIBE_DEFAULTS.preset) as PcoPreset };
        const raw = await bars(ctx, symbol, new Date(+at - 10 * DAY), at, "15m");
        const rth = raw.filter((b) => { const wd = weekday(localParts(b.t, tz).ymd), m = minutesOf(b.t, tz); return wd >= 1 && wd <= 5 && m >= 570 && m < 960; }) // regular hours only
          .filter((b) => +b.t + 15 * 60_000 <= +at); // closed candles only
        const day = rth.length ? localParts(rth[rth.length - 1].t, tz).ymd : ymd;
        const session = rth.filter((b) => localParts(b.t, tz).ymd === day);
        return { symbol, timeframe: "15m, regular hours, closed candles", session_date: day, as_of: clock ? iso(clock) : null, ...vibeRead(rth, session, opt), note: "Educational, not advice. Every number is computed by the server; report them as given." };
      }

      case "options": {
        const symbol = symbolOf(a), at = clock ?? new Date(ctx.now()), side = a.side === "call" || a.side === "put" ? a.side : "both";
        const expiry = resolveExpiry(String(a.expiry || "0dte"), at, tz), T = Math.max(0, (+expiryInstant(expiry, tz) - +at) / YEAR);
        const k = Math.max(1, Math.min(10, Number(a.strikes) || 4));
        if (clock) {
          const sp = await spotAt(ctx, symbol, clock), iv = await volAt(ctx, symbol, clock, a.iv), inc = step(sp.price), atm = Math.round(sp.price / inc) * inc;
          const rows = [];
          for (let i = -k; i <= k; i++) {
            const K = r2(atm + i * inc);
            for (const sd of ["call", "put"] as const) if (side === "both" || side === sd) { const m = bs(sd, sp.price, K, T, rateOf(ctx), iv); rows.push({ side: sd, strike: K, price: r2(m.price), delta: r2(m.delta), theta_per_day: r2(m.theta_per_day) }); }
          }
          return { symbol, mode: "time_travel", source: "model", as_of: iso(clock), spot: r2(sp.price), expiry, days_to_expiry: r2(T * 365), assumed_iv: r4(iv), rows, note: `${TT_NOTE} Yahoo has no historical option prices: these are Black-Scholes values at that spot with an assumed volatility, not quotes.` };
        }
        const y = await yf(), q = await y.quote(symbol), spot = q.regularMarketPrice;
        const chain = await y.options(symbol, { date: new Date(`${expiry}T12:00:00Z`) });
        const c = chain?.options?.[0];
        if (!c) throw new Error(`Yahoo lists no options for ${symbol} expiring ${expiry}`);
        const near = (rows: any[], sd: Side) => (rows ?? []).sort((p: any, q2: any) => Math.abs(p.strike - spot) - Math.abs(q2.strike - spot)).slice(0, k * 2 + 1).sort((p: any, q2: any) => p.strike - q2.strike)
          .map((o: any) => ({ side: sd, strike: o.strike, bid: o.bid, ask: o.ask, last: o.lastPrice, iv: o.impliedVolatility === undefined ? undefined : r4(o.impliedVolatility), volume: o.volume, open_interest: o.openInterest, delta: o.impliedVolatility > 0 && T > 0 ? r2(bs(sd, spot, o.strike, T, rateOf(ctx), o.impliedVolatility).delta) : undefined }));
        return { symbol, mode: "live", source: "yahoo", spot, expiry, rows: [...(side !== "put" ? near(c.calls, "call") : []), ...(side !== "call" ? near(c.puts, "put") : [])], note: "Real chain from Yahoo; delta is computed from each option's implied volatility." };
      }

      case "pick": {
        const symbol = symbolOf(a), at = clock ?? new Date(ctx.now());
        needChecks(ctx, symbol, localParts(at, tz).ymd);
        const side: Side = a.side === "put" ? "put" : "call", position = a.position === "short" ? "short" : "long";
        const strike = Number(a.strike);
        if (!(strike > 0)) throw new Error("strike is required");
        const expiry = resolveExpiry(String(a.expiry || "0dte"), at, tz), exit = parseWhen(String(a.exit_at), tz);
        if (+exit <= +at) throw new Error("exit_at must be after the moment of the pick");
        if (+exit > +expiryInstant(expiry, tz) + 1000) throw new Error("exit_at is after the option expires");
        const sp = clock ? await spotAt(ctx, symbol, clock) : { price: Number((await (await yf()).quote(symbol)).regularMarketPrice), at, prev_close: null };
        const iv = await volAt(ctx, symbol, at, a.iv), T = (+expiryInstant(expiry, tz) - +at) / YEAR;
        const m = bs(side, sp.price, strike, T, rateOf(ctx), iv);
        const pick: Pick = { id: `p${s.picks.length + 1}`, turn: ctx.turn, symbol, side, position, strike, expiry, entry_at: iso(at), exit_at: iso(exit), spot_at_entry: r2(sp.price), iv: r4(iv), modeled_entry: r2(m.price), note: a.note ? String(a.note).slice(0, 200) : undefined, live: !clock };
        save({ ...s, picks: [...s.picks, pick] });
        return { recorded: pick, note: `Recorded with the information available at ${iso(at)}. The outcome stays hidden until a later turn (reveal ${pick.id}).` };
      }

      case "reveal": {
        const pick = s.picks.find((p) => p.id === a.pick_id) ?? (s.picks.filter((p) => !p.revealed).length === 1 ? s.picks.find((p) => !p.revealed) : undefined);
        if (!pick) throw new Error("no such pick (use journal to list them)");
        if (pick.revealed) return { already_revealed: pick };
        if (pick.turn >= ctx.turn) throw new Error("a pick can only be revealed on a later turn: no peeking in the turn it is made");
        const entry = new Date(pick.entry_at), exit = new Date(pick.exit_at);
        if (pick.live && +exit > ctx.now()) throw new Error(`the exit time (${pick.exit_at}) has not come yet`);
        const path = await bars(ctx, pick.symbol, entry, exit, "5m");
        if (!path.length) throw new Error("no price data between entry and exit (is it a market day, and within the last 60 days?)");
        const last = path.at(-1)!, hi = Math.max(...path.map((b) => b.h)), lo = Math.min(...path.map((b) => b.l));
        const Tx = Math.max(0, (+expiryInstant(pick.expiry, tz) - +exit) / YEAR);
        const exitPrice = bs(pick.side, last.c, pick.strike, Tx, rateOf(ctx), pick.iv).price;
        const pnl = ((exitPrice - pick.modeled_entry) / Math.max(pick.modeled_entry, 0.01)) * 100 * (pick.position === "short" ? -1 : 1);
        const verdict = pnl > 0 ? "right" : "wrong";
        const revealed = { spot_at_exit: r2(last.c), modeled_exit: r2(exitPrice), pnl_pct: r2(pnl), underlying_move_pct: r2(((last.c - pick.spot_at_entry) / pick.spot_at_entry) * 100), verdict: verdict as "right" | "wrong", high: r2(hi), low: r2(lo) };
        const picks = s.picks.map((p) => (p.id === pick.id ? { ...p, revealed } : p));
        save({ ...s, picks, right: s.right + (verdict === "right" ? 1 : 0), wrong: s.wrong + (verdict === "wrong" ? 1 : 0), asOf: undefined }); // the future has been seen: back to live
        return { pick: { ...pick, revealed }, verdict, note: "MODELED outcome: Yahoo has no historical option prices, so entry and exit are Black-Scholes values with the same assumed volatility (the underlying's move and time decay count; volatility changes do not). The clock is cleared.", record: { right: s.right + (verdict === "right" ? 1 : 0), wrong: s.wrong + (verdict === "wrong" ? 1 : 0) } };
      }

      case "journal": {
        const total = s.right + s.wrong;
        return { picks: s.picks.slice(-12).map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, position: p.position, strike: p.strike, expiry: p.expiry, entry_at: p.entry_at, exit_at: p.exit_at, status: p.revealed ? p.revealed.verdict : "pending", pnl_pct: p.revealed?.pnl_pct, note: p.note })), right: s.right, wrong: s.wrong, hit_rate_pct: total ? r2((s.right / total) * 100) : null };
      }

      default: throw new Error("action must be quote, history, news, calendar, vibe, options, set_clock, clear_clock, clock, pick, reveal or journal");
    }
  },
};
export default stock;
