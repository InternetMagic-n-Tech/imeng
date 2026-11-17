/** Technical analysis in code (pure functions): the Vibe Trader's tools. The model never computes an indicator, it reads these. */

export interface Candle { t: Date; o: number; h: number; l: number; c: number; v: number }
type Num = number | null;

export const sma = (xs: number[], len: number): Num[] => xs.map((_, i) => (i + 1 < len ? null : xs.slice(i + 1 - len, i + 1).reduce((a, b) => a + b, 0) / len));
/** Population standard deviation, as TradingView's ta.stdev. */
export const stdev = (xs: number[], len: number): Num[] => xs.map((_, i) => {
  if (i + 1 < len) return null;
  const w = xs.slice(i + 1 - len, i + 1), m = w.reduce((a, b) => a + b, 0) / len;
  return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / len);
});
/** EMA seeded with the first value (the PCO script's own ema function). */
export function ema(xs: number[], len: number): number[] {
  const a = 2 / (len + 1), out: number[] = [];
  xs.forEach((x, i) => out.push(i === 0 ? x : a * x + (1 - a) * out[i - 1]));
  return out;
}
export function tma(xs: number[], len: number): number[] {
  const e1 = ema(xs, len), e2 = ema(e1, len), e3 = ema(e2, len);
  return e1.map((v, i) => 3 * (v - e2[i]) + e3[i]);
}

// ---------- Bollinger, OBV, stochastic ----------
export function bollinger(closes: number[], len = 20, k = 2): { mid: Num[]; upper: Num[]; lower: Num[] } {
  const mid = sma(closes, len), sd = stdev(closes, len);
  return { mid, upper: mid.map((m, i) => (m === null ? null : m + k * sd[i]!)), lower: mid.map((m, i) => (m === null ? null : m - k * sd[i]!)) };
}
export function obv(cs: Candle[]): number[] {
  const out: number[] = [];
  cs.forEach((c, i) => out.push(i === 0 ? 0 : out[i - 1] + (c.c > cs[i - 1].c ? c.v : c.c < cs[i - 1].c ? -c.v : 0)));
  return out;
}
export function stochastic(cs: Candle[], kLen = 14, kSmooth = 3, dLen = 3): { k: Num[]; d: Num[] } {
  const raw = cs.map((c, i) => {
    if (i + 1 < kLen) return null;
    const w = cs.slice(i + 1 - kLen, i + 1), hi = Math.max(...w.map((x) => x.h)), lo = Math.min(...w.map((x) => x.l));
    return hi === lo ? 50 : ((c.c - lo) / (hi - lo)) * 100;
  });
  const smooth = (xs: Num[], n: number): Num[] => xs.map((_, i) => { const w = xs.slice(Math.max(0, i + 1 - n), i + 1); return w.length < n || w.some((x) => x === null) ? null : (w as number[]).reduce((a, b) => a + b, 0) / n; });
  const k = smooth(raw, kSmooth);
  return { k, d: smooth(k, dLen) };
}

// ---------- Price Clouds Oscillator (a port of the TradingView script, normalisation off) ----------
export type PcoPreset = "Fast" | "Slow" | "Super Slow";
const PRESETS: Record<PcoPreset, { fast: number; slow: number; band: number; top: number; bot: number }> = {
  Fast: { fast: 7, slow: 14, band: 10, top: 0.75, bot: 0 },
  Slow: { fast: 14, slow: 26, band: 48, top: 2, bot: 1 },
  "Super Slow": { fast: 50, slow: 100, band: 200, top: 2, bot: 1 },
};
export interface PcoPoint { fast: number; slow: number; macd: number; hist_color: "grow_above" | "fall_above" | "grow_below" | "fall_below"; position: number; zone: "overbought" | "oversold" | "inside" }
export function pco(cs: Candle[], preset: PcoPreset = "Slow"): (PcoPoint | null)[] {
  const p = PRESETS[preset] ?? PRESETS.Slow, hl2 = cs.map((c) => (c.h + c.l) / 2), hi = cs.map((c) => c.h), lo = cs.map((c) => c.l);
  const fast = tma(hl2, p.fast), slow = tma(hl2, p.slow);
  const mh = sma(hi, p.band), sh = stdev(hi, p.band), ml = sma(lo, p.band), sl = stdev(lo, p.band);
  const out: (PcoPoint | null)[] = [];
  cs.forEach((_, i) => {
    if (mh[i] === null) { out.push(null); return; }
    const hTop = mh[i]! + p.top * sh[i]!, hBot = mh[i]! + p.bot * sh[i]!, lTop = ml[i]! - p.top * sl[i]!, lBot = ml[i]! - p.bot * sl[i]!;
    const mean = (hTop + hBot + lTop + lBot) / 4;
    const f = fast[i] - mean, s = slow[i] - mean, macd = f - s;
    const prev = out[i - 1]?.macd ?? macd;
    const color = macd >= 0 ? (prev < macd ? "grow_above" : "fall_above") : prev < macd ? "grow_below" : "fall_below";
    const max = hTop - mean, min = lTop - mean, position = max === min ? 0 : ((f - min) / (max - min) - 0.5) * 2;
    out.push({ fast: f, slow: s, macd, hist_color: color, position, zone: position >= 1 ? "overbought" : position <= -1 ? "oversold" : "inside" });
  });
  return out;
}
/** The most recent cross of the PCO fast line over the slow line (macd changing sign) within the last `within` candles. */
export function lastCross(points: (PcoPoint | null)[], within = 3): { direction: "up" | "down"; candles_ago: number } | null {
  for (let back = 0; back < within; back++) {
    const i = points.length - 1 - back, a = points[i], b = points[i - 1];
    if (a && b && ((b.macd < 0 && a.macd >= 0) || (b.macd >= 0 && a.macd < 0))) return { direction: a.macd >= 0 ? "up" : "down", candles_ago: back };
  }
  return null;
}

// ---------- Fibonacci swing, entry line and the hold ----------
export interface Swing { direction: "up" | "down"; start: number; end: number; start_index: number; end_index: number }
/** The session's swing: lowest low to highest high (up) if the low came first, otherwise highest high to lowest low (down). */
export function swing(session: Candle[]): Swing | null {
  if (session.length < 3) return null;
  let hi = 0, lo = 0;
  session.forEach((c, i) => { if (c.h >= session[hi].h) hi = i; if (c.l <= session[lo].l) lo = i; });
  if (session[hi].h === session[lo].l) return null;
  return lo < hi ? { direction: "up", start: session[lo].l, end: session[hi].h, start_index: lo, end_index: hi } : { direction: "down", start: session[hi].h, end: session[lo].l, start_index: hi, end_index: lo };
}
export interface Fib { entry_line: number; fib1: number; fib2: number; fib3: number }
/** The entry line is a retracement of the swing, fib1/2/3 are extensions of it measured from its start (1.0, 1.618, 2.618 by default). */
export function fibLevels(s: Swing, entry = 0.618, ext = [1, 1.618, 2.618]): Fib {
  const range = s.end - s.start, at = (r: number) => s.start + r * range;
  return { entry_line: s.end - entry * range, fib1: at(ext[0]), fib2: at(ext[1]), fib3: at(ext[2]) };
}
/** The hold: price has pulled back to the entry line after the swing's end, then `need` consecutive closed candles close on the right side of it (above for up, below for down). */
export function holdOf(closed: Candle[], s: Swing, line: number, need = 3): { touched: boolean; held: number; confirmed: boolean; signal_index: number | null } {
  let touch = -1;
  for (let i = s.end_index + 1; i < closed.length; i++) if (s.direction === "up" ? closed[i].l <= line : closed[i].h >= line) { touch = i; break; }
  const touched = touch >= 0;
  let held = 0;
  for (let i = closed.length - 1; touched && i >= touch; i--) { // closes before the pullback do not count
    if (s.direction === "up" ? closed[i].c > line : closed[i].c < line) held++; else break;
  }
  const confirmed = touched && held >= need;
  return { touched, held, confirmed, signal_index: confirmed ? closed.length - held + need - 1 : null };
}
