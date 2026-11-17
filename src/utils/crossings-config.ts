import { config, PHASES } from "./config.js";

/**
 * config.json `crossings` (off unless the block exists and its phases exist): the code behind "moving between two places".
 * The narrator ends a reply by sending everyone across and sets game.phase to `phase`. On the next turn (the player says anything) the server rolls what
 * the ambient does to each person (`effects`: per ambient value, per actor field, [lowest, highest]), moves game.place to the other of `places`,
 * and puts the phase back to `back`. `ad_break` (once per game, optional) replaces the effects on the first crossing: nobody is affected.
 */
const c: any = config.crossings && typeof config.crossings === "object" ? config.crossings : null;
const num = (n: unknown, d: number): number => (Number.isFinite(Number(n)) ? Number(n) : d);

export const CROSSINGS = c && PHASES && typeof c.phase === "string" && typeof c.back === "string" && PHASES[c.phase] && PHASES[c.back] ? {
  phase: c.phase as string,
  back: c.back as string,
  place: (typeof c.field === "string" ? c.field : "game.place").replace(/^game\./, ""),
  places: (Array.isArray(c.places) ? c.places.filter((p: unknown): p is string => typeof p === "string" && !!p) : []) as string[],
  ambient: (typeof c.ambient === "string" ? c.ambient : "game.ambient").replace(/^game\./, ""),
  effects: Object.fromEntries(Object.entries(c.effects && typeof c.effects === "object" ? c.effects : {}).map(([k, v]) => [k, Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).flatMap(([f, r]) => Array.isArray(r) && r.length === 2 && r.every((x) => Number.isFinite(Number(x))) ? [[f, [Math.min(Number(r[0]), Number(r[1])), Math.max(Number(r[0]), Number(r[1]))]]] : []))])) as Record<string, Record<string, [number, number]>>,
  min: num(c.min, 0),
  max: num(c.max, 10),
  adAt: Math.max(1, Math.floor(num(c.ad_break?.at_crossing, 2))),
  adBreak: c.ad_break && typeof c.ad_break === "object" && typeof c.ad_break.text === "string" ? (c.ad_break.text as string) : "",
  texts: { arrive: "The contestants have crossed to the {place} ({ambient} weather).", change: "{name}: {field} {delta}.", none: "The weather did nothing to anyone this time.", ...(c.texts && typeof c.texts === "object" ? c.texts : {}) } as Record<string, string>,
} : null;
