import { bollinger, fibLevels, holdOf, lastCross, obv, pco, stochastic, swing } from "./ta.js";
import type { Candle, PcoPreset } from "./ta.js";

/**
 * The Vibe Trader's read of one symbol, from CLOSED 15-minute candles of regular trading hours only. All of it is computed here; the narrator only
 * reports it. The method: a swing in today's session gives an entry line (a retracement) and three fib targets; the entry counts when price has
 * pulled back to the line and then closed on the right side of it for `hold` candles in a row; OBV lower than it was when that signal formed warns of
 * a dump; Bollinger bands, the stochastic and the PCO cross must agree for price to be expected to travel between the bands.
 */
export interface VibeOptions { hold: number; entryFib: number; ext: number[]; preset: PcoPreset; sellFib2: number; sellFib3: number }
export const VIBE_DEFAULTS: VibeOptions = { hold: 3, entryFib: 0.618, ext: [1, 1.618, 2.618], preset: "Slow", sellFib2: 0.33, sellFib3: 0.7 };

const r2 = (n: number): number => Math.round(n * 100) / 100;
const last = <T>(xs: T[]): T => xs[xs.length - 1];

export function vibeRead(all: Candle[], session: Candle[], o: VibeOptions = VIBE_DEFAULTS): Record<string, unknown> {
  if (all.length < 30 || session.length < 3) return { verdict: "not_enough_data", note: `Need at least 30 closed 15m candles of regular hours (and 3 in today's session); have ${all.length} (${session.length} today).` };
  const price = last(all).c, base = all.length - session.length; // session candles are the suffix of `all`
  const sw = swing(session);
  const bb = bollinger(all.map((c) => c.c)), i = all.length - 1;
  const upper = bb.upper[i], lower = bb.lower[i], mid = bb.mid[i];
  const st = stochastic(all), k = st.k[i], d = st.d[i], kPrev = st.k[i - 1], dPrev = st.d[i - 1];
  const stochCross = k !== null && d !== null && kPrev !== null && dPrev !== null && kPrev <= dPrev !== (k <= d) ? (k > d ? "up" : "down") : null;
  const pc = pco(all, o.preset), pnow = last(pc), cross = lastCross(pc, 3);
  const out: Record<string, unknown> = {
    last_candle: last(all).t.toISOString(), price: r2(price), candles_today: session.length,
    bollinger: upper === null ? null : { upper: r2(upper!), mid: r2(mid!), lower: r2(lower!), pct_b: r2((price - lower!) / (upper! - lower!)), bandwidth_pct: r2(((upper! - lower!) / mid!) * 100) },
    stochastic: k === null ? null : { k: r2(k), d: d === null ? null : r2(d), zone: k >= 80 ? "overbought" : k <= 20 ? "oversold" : "middle", cross: stochCross },
    pco: pnow ? { preset: o.preset, zone: pnow.zone, position: r2(pnow.position), macd: r2(pnow.macd * 1000) / 1000, histogram: pnow.hist_color, cross } : null,
  };
  if (!sw) return { ...out, verdict: "no_swing", note: "Today's candles show no swing yet." };
  const fib = fibLevels(sw, o.entryFib, o.ext), up = sw.direction === "up";
  const rel = session.map((_, n) => base + n), closedSession = session; // hold and OBV signal use the session's own indexes
  const hold = holdOf(closedSession, sw, fib.entry_line, o.hold);
  const obvAll = obv(all), obvNow = last(obvAll);
  const sigAbs = hold.signal_index === null ? null : rel[hold.signal_index];
  const obvAtSignal = sigAbs === null ? null : obvAll[sigAbs];
  const against = obvAtSignal === null ? null : up ? obvNow < obvAtSignal : obvNow > obvAtSignal;
  const entry = { line: r2(fib.entry_line), touched: hold.touched, candles_held: hold.held, needed: o.hold, confirmed: hold.confirmed };
  const agree = {
    pco: pnow ? (up ? pnow.macd > 0 || cross?.direction === "up" : pnow.macd < 0 || cross?.direction === "down") : false,
    stochastic: k === null ? false : up ? k < 80 : k > 20,
    bollinger: upper === null ? false : up ? price < upper! : price > lower!,
  };
  const disagree = Object.entries(agree).filter(([, v]) => !v).map(([n]) => n);
  let verdict: string;
  if (!hold.touched) verdict = "waiting_for_pullback";
  else if (!hold.confirmed) verdict = "waiting_for_hold";
  else if (against) verdict = "avoid_obv_warns_of_dump";
  else verdict = disagree.length ? "setup_mixed" : "setup_ready";
  const trade = verdict === "setup_ready" || verdict === "setup_mixed";
  return {
    ...out, verdict, direction: up ? "long (calls)" : "short (puts)",
    swing: { from: r2(sw.start), to: r2(sw.end) },
    levels: { entry_line: r2(fib.entry_line), fib1: r2(fib.fib1), fib2: r2(fib.fib2), fib3: r2(fib.fib3), stop_below_swing_start: r2(sw.start) },
    entry,
    obv: { now: Math.round(obvNow), at_signal: obvAtSignal === null ? null : Math.round(obvAtSignal), warns_of_reversal: against },
    agreement: { ...agree, disagree },
    range_between_bands_expected: verdict === "setup_ready" && upper !== null,
    plan: trade ? {
      fib1: "usually reached without much trouble: hold",
      fib2: `a good place to sell a portion (about ${Math.round(o.sellFib2 * 100)}%)`,
      fib3: `sell most of what remains (about ${Math.round(o.sellFib3 * 100)}% of it); keep a little to build on later, or get out`,
    } : undefined,
  };
}
