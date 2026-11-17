/** Black-Scholes for European options (no dividends): what a model can say about an option when there is no historical option data. */

const SQRT2 = Math.SQRT2;
/** Abramowitz-Stegun 7.1.26 error function (max error about 1.5e-7). */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const normCdf = (x: number): number => 0.5 * (1 + erf(x / SQRT2));
const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export type Side = "call" | "put";
export interface BsResult { price: number; delta: number; gamma: number; theta_per_day: number; vega_per_point: number }

/**
 * S spot, K strike, T years to expiry, r risk-free rate, sigma annual volatility. At or past expiry the value is the intrinsic value.
 */
export function bs(side: Side, S: number, K: number, T: number, r: number, sigma: number): BsResult {
  if (!(S > 0) || !(K > 0)) throw new Error("spot and strike must be positive");
  if (!(T > 0) || !(sigma > 0)) {
    const intrinsic = Math.max(0, side === "call" ? S - K : K - S);
    return { price: intrinsic, delta: intrinsic > 0 ? (side === "call" ? 1 : -1) : 0, gamma: 0, theta_per_day: 0, vega_per_point: 0 };
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq, d2 = d1 - sq;
  const disc = Math.exp(-r * T);
  const price = side === "call" ? S * normCdf(d1) - K * disc * normCdf(d2) : K * disc * normCdf(-d2) - S * normCdf(-d1);
  const delta = side === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (S * sq);
  const thetaYear = -(S * normPdf(d1) * sigma) / (2 * Math.sqrt(T)) - (side === "call" ? 1 : -1) * r * K * disc * normCdf(side === "call" ? d2 : -d2);
  return { price, delta, gamma, theta_per_day: thetaYear / 365, vega_per_point: (S * normPdf(d1) * Math.sqrt(T)) / 100 };
}

/** Annualised volatility from a series of closes (log returns, 252 trading days). Null with fewer than 3 closes. */
export function realizedVol(closes: number[], periodsPerYear = 252): number | null {
  const c = closes.filter((x) => x > 0);
  if (c.length < 3) return null;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(periodsPerYear);
}
