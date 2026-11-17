/**
 * The dating-show core: the rules that must be code, not a model's opinion. Nothing here calls a model; a judge supplies the evidence (a
 * quoted line) and this code decides what it is worth.
 *
 * - Attraction is directed: attraction[from][to] is -1 (repulsion), 0 (indifferent), 1 (a good person), 2 (dating material) or 3 (intense crush). Below 1 it only colours dialogue; the finale needs 2 or 3.
 * - It moves by gates, never by a count, only with quoted evidence, only the server writes it. The first gate is level 1: any quoted evidence of warmth takes someone from -1 or 0 straight to 1. After that at most one level a check, and only evidence that reaches the next level (a shared taste reaches 1, a physical impression 2, a shared passion 3).
 * - Who may be King or Queen, who may win the date: single adults who are still in the show. The code reads the real age.
 * - The show clock is a fixed cost per action, whatever the real clock says.
 */
export type Attraction = Record<string, Record<string, number>>;
export type Kind = "interest" | "physical" | "passion" | "dislike";
export interface Evidence { kind: Kind; quote: string }

/** The highest level each kind of evidence can lift someone to: a shared taste (1), a physical or sensory impression (2), a shared passion (3). */
export const REACH: Record<Exclude<Kind, "dislike">, number> = { interest: 1, physical: 2, passion: 3 };
export const MAX_LEVEL = 3;
export const MIN_LEVEL = -1;

const solid = (e: Evidence): boolean => !!e && typeof e.quote === "string" && e.quote.trim().length >= 3;

/** One check from `cur`: down one level on a quoted dislike (a dealbreaker; the floor is -1, repulsion), else the first gate (any quoted warmth takes -1 or 0 to 1), else up one level if quoted evidence reaches the next level, else no change. */
export function stepAttraction(cur: number, evidence: Evidence[], crowd = 0): { next: number; reason: string } {
  const level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.floor(cur) || 0));
  const good = evidence.filter(solid);
  const dislike = good.find((e) => e.kind === "dislike");
  if (dislike) return level > MIN_LEVEL ? { next: level - 1, reason: `dislike: ${dislike.quote.trim()}` } : { next: MIN_LEVEL, reason: "dislike, already at the floor" };
  const warm = good.filter((e) => e.kind !== "dislike");
  const up = level < 1 ? warm[0] : warm.find((e) => REACH[e.kind as Exclude<Kind, "dislike">] >= level + 1);
  if (up && level < MAX_LEVEL && crowd < 0) return { next: level, reason: "resisted the crowd" }; // a contrarian digs in when the crowd pushes
  if (up && level < MAX_LEVEL) return { next: level < 1 ? 1 : level + 1, reason: `${up.kind}: ${up.quote.trim()}` };
  // A receptive crowd (peer pressure): quoted evidence that does not reach the next level still lifts it by one, but never past `crowd` (the cap the imeng sets, 2 at most): real passion is still needed for the top.
  const any = warm[0];
  if (any && crowd > 0 && level < Math.min(MAX_LEVEL, crowd)) return { next: level + 1, reason: `crowd: ${any.kind}: ${any.quote.trim()}` };
  return { next: level, reason: "no change" };
}

export interface Contestant { id: string; age?: number | null; status?: string; left?: boolean }

/** Single, an adult, and still in the show. A minor may compete, but is never eligible (attraction toward them stays 0 too). */
export const eligible = (c: Contestant): boolean => !c.left && c.status === "single" && typeof c.age === "number" && c.age >= 18;
export const isMinor = (c: Contestant): boolean => typeof c.age === "number" && c.age < 18;

/** What the narrator is told about someone's age: never the number. */
export const ageWord = (c: Contestant): "adult" | "minor" | "unknown" => (typeof c.age !== "number" ? "unknown" : c.age >= 18 ? "adult" : "minor");

/** Apply a check for one pair, keeping the rules the code owns: a minor is never above 0, and nobody feels anything about themselves. */
export function applyCheck(att: Attraction, from: Contestant, to: Contestant, evidence: Evidence[], crowd = 0): { att: Attraction; changed: boolean; reason: string } {
  if (from.id === to.id) return { att, changed: false, reason: "self" };
  const cur = att[from.id]?.[to.id] ?? 0;
  if (isMinor(from) || isMinor(to)) return { att, changed: false, reason: "minor" };
  const r = stepAttraction(cur, evidence, crowd);
  if (r.next === cur) return { att, changed: false, reason: r.reason };
  return { att: { ...att, [from.id]: { ...(att[from.id] ?? {}), [to.id]: r.next } }, changed: true, reason: r.reason };
}

/** An NPC points at the eligible person they are most attracted to (ties at random via `rng`); nobody if none reaches `atLeast`. */
export function npcPoint(att: Attraction, from: string, candidates: Contestant[], rng: () => number = Math.random, atLeast = 2): string | null {
  const scored = candidates.filter((c) => c.id !== from && eligible(c)).map((c) => ({ id: c.id, v: att[from]?.[c.id] ?? 0 })).filter((x) => x.v >= atLeast);
  if (!scored.length) return null;
  const top = Math.max(...scored.map((x) => x.v));
  const best = scored.filter((x) => x.v === top);
  return best[Math.min(best.length - 1, Math.floor(rng() * best.length))]!.id;
}

/** The first pair who point at each other, both eligible, both at 2 or 3 toward the other: the King and Queen. Only one match is made. */
export function finaleMatch(att: Attraction, pointing: Record<string, string | null>, people: Contestant[]): [string, string] | null {
  const by = new Map(people.map((p) => [p.id, p]));
  for (const a of people) {
    const b = pointing[a.id];
    if (!b || b === a.id || pointing[b] !== a.id) continue;
    const pa = by.get(a.id), pb = by.get(b);
    if (!pa || !pb || !eligible(pa) || !eligible(pb)) continue;
    if ((att[a.id]?.[b] ?? 0) >= 2 && (att[b]?.[a.id] ?? 0) >= 2 && a.id < b) return [a.id, b];
  }
  return null;
}

/** The show clock: every action costs fixed minutes. Unknown actions cost nothing; the real clock never matters. */
export interface ClockCfg { total: number; costs: Record<string, number>; warn_at?: number[] }
export function spend(minutes: number, action: string, cfg: ClockCfg): { minutes: number; over: boolean; warnings: number[] } {
  const next = minutes + (cfg.costs[action] ?? 0);
  return { minutes: next, over: next >= cfg.total, warnings: (cfg.warn_at ?? []).filter((w) => minutes < w && next >= w) };
}
