import { describe, it, expect } from "@jest/globals";
import { bollinger, ema, fibLevels, holdOf, lastCross, obv, pco, sma, stdev, stochastic, swing, tma } from "../src/tools/ta.js";
import type { Candle } from "../src/tools/ta.js";
import { vibeRead } from "../src/tools/vibe.js";
import { dayBrief, readEvents } from "../src/tools/calendar.js";

const T0 = Date.UTC(2026, 10, 2, 14, 30);
const cd = (i: number, o: number, h: number, l: number, c: number, v = 100): Candle => ({ t: new Date(T0 + i * 900_000), o, h, l, c, v });
const flat = (n: number, p = 100): Candle[] => Array.from({ length: n }, (_, i) => cd(i, p, p + 0.5, p - 0.5, p + (i % 2 ? 0.1 : -0.1)));

describe("indicators", () => {
  it("sma, stdev (population), ema seeded with the first value, tma of a constant", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(stdev([1, 3], 2)[1]).toBe(1);
    expect(ema([10, 20], 3)).toEqual([10, 15]);
    expect(tma([5, 5, 5, 5], 4).every((x) => Math.abs(x - 5) < 1e-9)).toBe(true);
  });
  it("bollinger bands collapse on a constant, obv adds on up closes and subtracts on down closes, stochastic stays 0-100", () => {
    const b = bollinger(Array(25).fill(7)); expect(b.upper[24]).toBe(7); expect(b.lower[24]).toBe(7);
    expect(obv([cd(0, 1, 1, 1, 10, 5), cd(1, 1, 1, 1, 11, 7), cd(2, 1, 1, 1, 10, 3), cd(3, 1, 1, 1, 10, 9)])).toEqual([0, 7, 4, 4]);
    const s = stochastic(Array.from({ length: 30 }, (_, i) => cd(i, 1, 100 + i, 90 + i, 95 + i + (i % 3))));
    expect(s.k.filter((x) => x !== null).every((x) => x! >= 0 && x! <= 100)).toBe(true);
    expect(stochastic(flat(5)).k.every((x) => x === null)).toBe(true);
  });
});

describe("price clouds oscillator", () => {
  it("is flat on a flat market and null until the bands have a full window", () => {
    const p = pco(flat(60));
    expect(p.slice(0, 47).every((x) => x === null)).toBe(true);
    expect(Math.abs(p[59]!.macd)).toBeLessThan(0.2);
  });
  it("turns positive and grows in a steady climb, and reports an overbought position", () => {
    const up = [...flat(60), ...Array.from({ length: 15 }, (_, i) => cd(60 + i, 100 + 2 * i, 101 + 2 * i, 99 + 2 * i, 100.5 + 2 * i))];
    const p = pco(up);
    expect(p[74]!.macd).toBeGreaterThan(0);
    expect(["grow_above", "fall_above"]).toContain(p[74]!.hist_color);
    expect(p[74]!.position).toBeGreaterThan(0);
  });
  it("finds a cross within the last candles", () => {
    const pts = [{ macd: -1 }, { macd: -0.2 }, { macd: 0.3 }, { macd: 0.5 }] as never[];
    expect(lastCross(pts, 3)).toEqual({ direction: "up", candles_ago: 1 });
    expect(lastCross(pts, 1)).toBeNull();
    expect(lastCross([{ macd: 1 }, { macd: -1 }] as never[], 2)).toEqual({ direction: "down", candles_ago: 0 });
  });
});

describe("fib swing, entry line and the hold", () => {
  const sess = [cd(0, 100, 101, 100, 100.5), cd(1, 101, 106, 100.8, 105), cd(2, 105, 110, 104, 109), cd(3, 109, 109.5, 104.5, 105), cd(4, 105, 106, 103.5, 104.5), cd(5, 104.5, 106, 104, 105), cd(6, 105, 106.5, 104.6, 105.5), cd(7, 105.5, 107, 105, 106)];
  it("finds the swing and the levels", () => {
    const s = swing(sess)!;
    expect(s).toMatchObject({ direction: "up", start: 100, end: 110 });
    const f = fibLevels(s);
    expect(f.entry_line).toBeCloseTo(103.82, 2); expect(f.fib1).toBe(110); expect(f.fib2).toBeCloseTo(116.18, 2); expect(f.fib3).toBeCloseTo(126.18, 2);
    const down = swing([cd(0, 110, 110, 109, 109), cd(1, 108, 108, 100, 101), cd(2, 101, 102, 100.5, 101)])!;
    expect(down.direction).toBe("down");
    expect(fibLevels(down).entry_line).toBeCloseTo(106.18, 2);
    expect(swing(sess.slice(0, 2))).toBeNull();
  });
  it("needs the pullback to the line and then three closes above it", () => {
    const s = swing(sess)!, line = fibLevels(s).entry_line;
    expect(holdOf(sess, s, line)).toMatchObject({ touched: true, held: 4, confirmed: true, signal_index: 6 });
    expect(holdOf(sess.slice(0, 6), s, line)).toMatchObject({ touched: true, held: 2, confirmed: false, signal_index: null });
    expect(holdOf(sess.slice(0, 4), s, line).touched).toBe(false);
  });
});

describe("the Vibe Trader's read", () => {
  const prior = flat(40, 100).map((c, i) => ({ ...c, t: new Date(T0 - 86_400_000 + i * 900_000) }));
  const base: Candle[] = [cd(0, 100, 101, 100, 100.5), cd(1, 101, 106, 100.8, 105), cd(2, 105, 110, 104, 109), cd(3, 109, 109.5, 104.5, 105), cd(4, 105, 106, 103.5, 104.5), cd(5, 104.5, 106, 104, 105, 300), cd(6, 105, 106.5, 104.6, 105.5, 300), cd(7, 105.5, 107, 105, 106, 300)];
  const read = (session: Candle[]) => vibeRead([...prior, ...session], session) as any;
  it("needs enough data", () => { expect(vibeRead(flat(5), flat(5)).verdict).toBe("not_enough_data"); });
  it("waits for the pullback, then for the hold, then confirms", () => {
    expect(read(base.slice(0, 3)).verdict).toBe("waiting_for_pullback");
    expect(read(base.slice(0, 6)).verdict).toBe("waiting_for_hold");
    const r = read(base);
    expect(r.entry).toMatchObject({ confirmed: true, candles_held: 4 });
    expect(r.levels).toMatchObject({ entry_line: 103.82, fib1: 110, stop_below_swing_start: 100 });
    expect(["setup_ready", "setup_mixed"]).toContain(r.verdict);
    expect(r.plan.fib2).toMatch(/portion/);
    expect(r.obv.warns_of_reversal).toBe(false);
  });
  it("warns of a dump when OBV falls below where it was at the signal, even while price still holds", () => {
    const r = read([...base, cd(8, 106, 106, 104.5, 104.9, 900)]);
    expect(r.entry.confirmed).toBe(true);
    expect(r.obv.warns_of_reversal).toBe(true);
    expect(r.verdict).toBe("avoid_obv_warns_of_dump");
  });
  it("re-anchors when price breaks the swing start: the new low makes a down swing, not an up setup", () => {
    const r = read([...base, cd(8, 106, 106, 98, 99, 500)]);
    expect(r.direction).toBe("short (puts)");
    expect(r.verdict).toBe("waiting_for_pullback");
  });
  it("mirrors for a down swing", () => {
    const mirror = base.map((c, i) => cd(i, 200 - c.o, 200 - c.l, 200 - c.h, 200 - c.c, c.v));
    const r = vibeRead([...prior.map((c) => ({ ...c, o: 200 - c.o, h: 200 - c.l, l: 200 - c.h, c: 200 - c.c })), ...mirror], mirror) as any;
    expect(r.direction).toBe("short (puts)");
    expect(r.entry.confirmed).toBe(true);
  });
  it("reports no swing on a dead-flat session", () => {
    const s = [cd(0, 100, 100, 100, 100), cd(1, 100, 100, 100, 100), cd(2, 100, 100, 100, 100)];
    expect(read(s).verdict).toBe("no_swing");
  });
});

describe("calendar file", () => {
  it("reads a list or an {events} wrapper, drops bad rows, and orders the day", () => {
    const raw = JSON.stringify({ events: [{ date: "2026-11-09", time: "9:00", event: "B", impact: "low" }, { date: "bad", event: "x" }, { date: "2026-11-09", event: "NoTime", impact: "weird" }] });
    const ev = readEvents({ calendar_file: "c.json" }, "/g", () => raw);
    expect(ev.map((e) => [e.event, e.time, e.impact])).toEqual([["B", "09:00", "low"], ["NoTime", undefined, "medium"]]);
    expect(dayBrief(ev, "2026-11-09").events.map((e) => e.event)).toEqual(["B", "NoTime"]);
    expect(readEvents({ calendar: [{ date: "2026-11-09", event: "Z" }] }, "/g")).toHaveLength(1);
    expect(readEvents({}, "/g")).toEqual([]);
  });
});
