/**
 * Durations written by people ("5d", "2 hours", "90 min") or by the judge model. Real time is milliseconds; in-game time is counted
 * in the unit of the game's clock (config.json: multiplayer.clock).
 */

const MS: Record<string, number> = {
  s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3,
  m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
  h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5,
  d: 864e5, day: 864e5, days: 864e5,
  w: 6048e5, wk: 6048e5, wks: 6048e5, week: 6048e5, weeks: 6048e5,
  mo: 2592e6, month: 2592e6, months: 2592e6,
  y: 31536e6, yr: 31536e6, yrs: 31536e6, year: 31536e6, years: 31536e6,
};

export type ClockUnit = "second" | "minute" | "hour" | "day" | "week" | "count";
export const CLOCK_UNITS: ClockUnit[] = ["second", "minute", "hour", "day", "week", "count"];
const UNIT_MS: Record<Exclude<ClockUnit, "count">, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 };

const SHAPE = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i;

/** "5d", "5 days", "1.5h" -> milliseconds. Null when it is not a duration (a bare number has no unit). */
export function parseDurationMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = SHAPE.exec(v);
  if (!m || !m[2]) return null;
  const unit = MS[m[2].toLowerCase()];
  return unit ? Math.round(Number(m[1]) * unit) : null;
}

/**
 * An in-game duration in the clock's own unit. Clock unit "count" (a plain counter such as game.round) takes a number, or a number
 * followed by any word ("3 rounds"); the other units take a real duration ("2 hours") and convert it.
 */
export function parseGameDuration(v: unknown, unit: ClockUnit): number | null {
  if (unit === "count") {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
    const m = typeof v === "string" ? SHAPE.exec(v) : null;
    return m && Number(m[1]) > 0 ? Number(m[1]) : null;
  }
  const ms = parseDurationMs(v);
  return ms === null ? null : ms / UNIT_MS[unit];
}

/** "3 days", "2 h 5 min", "under a minute": for telling the narrator how long someone was gone. */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "under a minute";
  const parts: string[] = [];
  const add = (n: number, w: string): void => { if (n > 0) parts.push(`${n} ${w}${n === 1 ? "" : "s"}`); };
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  add(d, "day"); add(h, "hour"); if (d === 0) add(m, "minute");
  return parts.slice(0, 2).join(" ");
}
