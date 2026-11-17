import { describe, it, expect, beforeEach } from "@jest/globals";
import stock, { setYahoo } from "../src/tools/stock.js";
import type { ToolContext } from "../src/tools/index.js";

const NOW = Date.UTC(2026, 10, 9, 16, 30); // Mon 2026-11-09 11:30 ET
const q = (iso: string, o: number, h: number, l: number, c: number, v = 100) => ({ date: new Date(iso), open: o, high: h, low: l, close: c, volume: v });
const prior = Array.from({ length: 26 }, (_, i) => { const t = Date.UTC(2026, 10, 6, 14, 30) + i * 900_000; return q(new Date(t).toISOString(), 100, 100.5, 99.5, 100 + (i % 2 ? 0.1 : -0.1)); });
const premarket = q("2026-11-09T12:00:00Z", 100, 101, 99, 100.5, 50); // outside regular hours: must be ignored
const shape: [number, number, number, number, number][] = [[100, 101, 100, 100.5, 100], [101, 106, 100.8, 105, 100], [105, 110, 104, 109, 100], [109, 109.5, 104.5, 105, 100], [105, 106, 103.5, 104.5, 100], [104.5, 106, 104, 105, 300], [105, 106.5, 104.6, 105.5, 300], [105.5, 107, 105, 106, 300]];
const today = shape.map((s, i) => q(new Date(Date.UTC(2026, 10, 9, 14, 30) + i * 900_000).toISOString(), ...s));
const open15 = q(new Date(Date.UTC(2026, 10, 9, 16, 15)).toISOString(), 106, 108, 105, 107, 999); // starts 16:15, ends 16:30: closed at NOW

let store: unknown;
const mk = (options: Record<string, unknown> = {}, turn = 1): ToolContext => ({
  turn, state: {} as never, options: { timezone: "America/New_York", ...options }, secrets: {},
  http: async () => { throw new Error("no http"); }, store: { get: <T>() => store as T | undefined, set: (v: unknown) => { store = v; } }, now: () => NOW,
});
const call = (a: Record<string, unknown>, ctx: ToolContext): Promise<any> => stock.run(a, ctx);
const calendar = [{ date: "2026-11-09", time: "08:30", event: "CPI", impact: "high" }, { date: "2026-11-09", time: "10:00", event: "Consumer sentiment", impact: "medium" }, { date: "2026-11-09", time: "14:00", event: "Fed speaker", impact: "high" }, { date: "2026-11-10", event: "PPI" }];

beforeEach(() => {
  store = undefined;
  setYahoo({
    chart: async () => ({ quotes: [...prior, premarket, ...today.slice(0, 7), open15] }), // the 7th session candle is replaced by open15 below
    quoteSummary: async () => ({ calendarEvents: { earnings: { earningsDate: [new Date("2026-11-09T12:00:00Z")] } } }),
    search: async () => ({ news: [{ title: "ACME beats", publisher: "Wire", link: "https://x", providerPublishTime: new Date(NOW - 3_600_000) }] }),
  });
});

describe("calendar", () => {
  it("lists the day's events and the morning's pitfalls, plus earnings from Yahoo", async () => {
    const r = await call({ action: "calendar", symbol: "ACME" }, mk({ calendar }));
    expect(r.events.map((e: any) => e.event)).toEqual(["CPI", "Consumer sentiment", "Fed speaker"]);
    expect(r.pitfalls[0]).toMatch(/CPI at 08:30 ET, BEFORE the open/);
    expect(r.pitfalls[1]).toMatch(/Consumer sentiment.*inside the morning session/);
    expect(r.pitfalls[2]).toMatch(/Fed speaker.*high impact/);
    expect(r.pitfalls[3]).toMatch(/ACME reports earnings today/);
    expect(r.clear).toBe(false);
  });
  it("says plainly when no calendar is configured, and when the day is clear", async () => {
    expect((await call({ action: "calendar" }, mk())).note).toMatch(/No calendar is configured/);
    const r = await call({ action: "calendar", date: "2026-11-10" }, mk({ calendar }));
    expect(r.clear).toBe(true);
  });
  it("says the calendar is out of date when it holds nothing near the day", async () => {
    const r = await call({ action: "calendar", date: "2026-12-30" }, mk({ calendar }));
    expect(r.note).toMatch(/needs updating/);
  });
  it("reads calendar_file only from inside the game folder", async () => {
    await expect(call({ action: "calendar" }, mk({ calendar_file: "../x.json" }))).rejects.toThrow(/inside the game folder/);
    await expect(call({ action: "calendar" }, mk({ calendar_file: "missing.json" }))).rejects.toThrow(/could not read/);
  });
});

describe("news and calendar first (require_checks)", () => {
  const opts = { calendar, require_checks: ["news", "calendar"] };
  it("refuses a read or a pick until both were looked at, then allows it", async () => {
    await expect(call({ action: "vibe", symbol: "ACME" }, mk(opts))).rejects.toThrow(/check news for ACME and the economic calendar for 2026-11-09 first/);
    await call({ action: "news", symbol: "ACME" }, mk(opts));
    await expect(call({ action: "vibe", symbol: "ACME" }, mk(opts))).rejects.toThrow(/the economic calendar/);
    await call({ action: "calendar" }, mk(opts));
    expect((await call({ action: "vibe", symbol: "ACME" }, mk(opts))).verdict).toBeDefined();
    await expect(call({ action: "pick", symbol: "ACME", strike: 100, exit_at: "2026-11-09T15:00" }, mk(opts, 9))).rejects.toThrow(/news for ACME/); // the news check has gone stale
  });
  it("is off unless the game asks for it", async () => {
    expect((await call({ action: "vibe", symbol: "ACME" }, mk({}))).verdict).toBeDefined();
  });
});

describe("vibe", () => {
  it("reads 15m regular-hours closed candles only and reports the plan", async () => {
    const r = await call({ action: "vibe", symbol: "ACME" }, mk());
    expect(r.timeframe).toMatch(/15m, regular hours, closed/);
    expect(r.session_date).toBe("2026-11-09");
    expect(r.candles_today).toBe(8); // 7 session candles + the one that closed at the clock; the pre-market one is out
    expect(r.levels.fib1).toBe(110);
    expect(["setup_ready", "setup_mixed", "avoid_obv_warns_of_dump"]).toContain(r.verdict);
    expect(r.note).toMatch(/Educational/);
  });
  it("drops the candle that has not closed yet", async () => {
    const r = await call({ action: "vibe", symbol: "ACME" }, { ...mk(), now: () => Date.UTC(2026, 10, 9, 16, 20) });
    expect(r.candles_today).toBe(7);
  });
});
