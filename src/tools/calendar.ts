import fs from "node:fs";
import path from "node:path";

/** The economic calendar: events from a file the game keeps (Yahoo has no economic calendar), and the pitfalls they make for the day's trading. */
export interface CalEvent { date: string; time?: string; event: string; impact?: "high" | "medium" | "low"; note?: string }

export function readEvents(options: Record<string, any>, gameDir: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): CalEvent[] {
  let raw: unknown = options.calendar;
  if (!raw && typeof options.calendar_file === "string") {
    const root = path.resolve(gameDir), file = path.resolve(root, options.calendar_file);
    if (!file.startsWith(root + path.sep)) throw new Error("calendar_file must be inside the game folder");
    try { raw = JSON.parse(readFile(file)); } catch (e) { throw new Error(`could not read ${options.calendar_file}: ${(e as Error).message}`); }
  }
  if (raw && !Array.isArray(raw) && Array.isArray((raw as any).events)) raw = (raw as any).events;
  if (!Array.isArray(raw)) return [];
  return raw.filter((e: any) => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) && typeof e.event === "string")
    .map((e: any) => ({ date: String(e.date), time: /^\d{1,2}:\d{2}$/.test(String(e.time ?? "")) ? String(e.time).padStart(5, "0") : undefined, event: e.event.slice(0, 120), impact: ["high", "medium", "low"].includes(e.impact) ? e.impact : "medium", note: typeof e.note === "string" ? e.note.slice(0, 200) : undefined }));
}

const minutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** The day's events in time order, and the pitfalls for the morning: anything before `warnUntil` (ET, default 11:30), and every high-impact event of the day. */
export function dayBrief(events: CalEvent[], ymd: string, warnUntil = "11:30"): { events: CalEvent[]; pitfalls: string[]; clear: boolean } {
  const today = events.filter((e) => e.date === ymd).sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99"));
  const pitfalls: string[] = [];
  for (const e of today) {
    const when = e.time ? `${e.time} ET` : "time not given";
    if (e.time && minutes(e.time) < 570) pitfalls.push(`${e.event} at ${when}, BEFORE the open: expect a gap or a repriced open.`);
    else if (e.time && minutes(e.time) <= minutes(warnUntil)) pitfalls.push(`${e.event} at ${when}, inside the morning session: candles around it are noise; do not trust an entry that forms into it.`);
    else if (e.impact === "high") pitfalls.push(`${e.event} at ${when} (high impact): size down and expect a sharp move at that time.`);
  }
  return { events: today, pitfalls, clear: pitfalls.length === 0 };
}
