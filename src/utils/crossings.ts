import crypto from "node:crypto";
import { dbg } from "./debug.js";
const log = dbg("crossings");
import { CROSSINGS } from "./crossings-config.js";
import { activeActors } from "./conditions.js";
import { PHASES } from "./config.js";
import type { GameState } from "./types.js";

/** The server's side of a crossing. Called once at the start of a turn; returns plain-language lines for the narrator (empty when no crossing is due). */
export function crossNow(state: GameState): string[] {
  const c = CROSSINGS;
  if (!c || !PHASES || state.game.phase !== c.phase) return [];
  const g = state.game as Record<string, any>;
  const prev = g.crossing && typeof g.crossing === "object" ? g.crossing : { count: 0, ad: false };
  const from = String(g[c.place] ?? "");
  const to = c.places.length === 2 ? (from === c.places[1] ? c.places[0] : c.places[1]) : from;
  const ad = !!c.adBreak && !prev.ad && Number(prev.count || 0) + 1 >= c.adAt;
  const lines: string[] = [];
  const say = (k: string, v: Record<string, string>): string => c.texts[k].replace(/\{(\w+)\}/g, (_, n) => v[n] ?? "");
  if (to) g[c.place] = to;
  const ambient = String(g[c.ambient] ?? "");
  lines.push(say("arrive", { place: to || "next area", ambient: ambient || "mild" }));
  if (ad) lines.push(c.adBreak);
  else {
    const eff = c.effects[ambient] ?? {};
    for (const [id, a] of activeActors(state)) {
      for (const [f, [lo, hi]] of Object.entries(eff)) {
        const cur = Number((a as any)?.[f]);
        if (!Number.isFinite(cur)) continue;
        const next = Math.max(c.min, Math.min(c.max, cur + crypto.randomInt(lo, hi + 1)));
        if (next === cur) continue;
        (a as any)[f] = next;
        lines.push(say("change", { name: String((a as any).name || id), field: f, delta: `${next > cur ? "rises" : "drops"} by ${Math.abs(next - cur)}` }));
      }
    }
    if (lines.length === 1) lines.push(c.texts.none);
  }
  g.crossing = { count: Number(prev.count || 0) + 1, ad: prev.ad || ad };
  g.phase = c.back;
  log("crossing %d to %s (ambient %s)%s: %j", g.crossing.count, to, ambient || "mild", ad ? ", ad break" : "", lines);
  return lines;
}
