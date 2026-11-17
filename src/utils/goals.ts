import { GOALS, goalText } from "./goals-config.js";
import { activeActors } from "./conditions.js";
import { applyCalc, enforcePhases } from "./phases.js";
import { flat } from "./text.js";
import type { Goal, GameState, GoalStore, Session } from "./types.js";

/**
 * Secret goals (config.json `goals`; docs/IMENG-MAKING.md). What a person wants lives in a server-side store on the session, outside every snapshot, so the
 * extractor, compactor and recaps never see it. The state only carries two server-written counters per actor (goals_set, goals_done), which is what
 * phases and calculated fields read. A judge proposes that a goal was reached; code accepts it only with words that really appear in the round.
 */

const MAX_TEXT = 200;
export const storeOf = (s: Session): GoalStore => (s.goals ??= { goals: [], seq: 0 });
export const goalsOf = (st: GoalStore, actor: string): Goal[] => st.goals.filter((g) => g.actor === actor);
const clean = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

/** Write a goal down: an error key (`empty`, `full`) or the goal. */
export function addGoal(st: GoalStore, actor: string, text: string, source: Goal["source"], reason = ""): { goal: Goal } | { error: "empty" | "full" } {
  const t = clean(text);
  if (!t) return { error: "empty" };
  const mine = goalsOf(st, actor);
  if (GOALS && mine.length >= GOALS.max) return { error: "full" };
  const same = mine.find((g) => flat(g.text) === flat(t));
  if (same) return { goal: same };
  const why = clean(reason);
  const goal: Goal = { id: `g${++st.seq}`, actor, text: t, source, ...(why ? { reason: why } : {}) };
  st.goals.push(goal);
  return { goal };
}

/** Keep the counters in the state in step with the store, then everything that is calculated from them. */
export function syncCounts(state: GameState, st: GoalStore): void {
  if (!GOALS) return;
  for (const [id, a] of Object.entries(state.actors)) {
    if (!a || typeof a !== "object") continue;
    const mine = goalsOf(st, id);
    a.goals_set = mine.length;
    a.goals_done = mine.filter((g) => g.done).length;
  }
  applyCalc(state);
}

/** After a round: counters, calculated values, and the phase gate again (a goal reached this round may open the next phase). */
export function settle(state: GameState, before: GameState, st: GoalStore): void {
  syncCounts(state, st);
  enforcePhases(state, before, []);
}

export interface Marked { goal: Goal; quote: string }
/** Accept the judge's list: only goals still open, of people still in, with a quote found in what was said and narrated. */
export function markDone(st: GoalStore, state: GameState, reached: { id: unknown; quote: unknown }[], turn: number, said: string): Marked[] {
  if (!GOALS) return [];
  const seen = ` ${flat(said)} `, active = new Set(activeActors(state).map(([id]) => id)), out: Marked[] = [];
  for (const r of reached) {
    const g = st.goals.find((x) => x.id === String(r.id));
    const q = typeof r.quote === "string" ? r.quote.trim() : "";
    if (!g || g.done || !active.has(g.actor) || flat(q).length < 3 || !seen.includes(` ${flat(q)} `)) continue;
    g.done = { turn, quote: q.slice(0, 200) };
    (st.reactions ??= []).push({ turn, actor: g.actor });
    const a = state.actors[g.actor];
    if (GOALS.reward === "points" && a) a[GOALS.scoreField] = (Number(a[GOALS.scoreField]) || 0) + GOALS.points;
    out.push({ goal: g, quote: g.done.quote });
  }
  return out;
}

/** A replayed round: goals reached on it or later are open again. */
export function rollbackGoals(st: GoalStore, turn: number): void {
  for (const g of st.goals) if (g.done && g.done.turn >= turn) delete g.done;
  if (st.reactions) st.reactions = st.reactions.filter((r) => r.turn < turn);
}

const nameOf = (state: GameState, id: string): string => String(state.actors[id]?.name || id);

/** Who has the most goals done: the id, or null on a tie or when nobody has one. */
/** Private text that was taken as a goal (a digest): foldPrivate leaves it out of what the narrator reads. */
export const digestOf = (t: string): string => flat(t);
export const consumedSkip = (st: GoalStore | undefined): ((t: string) => boolean) | undefined => (st?.consumed?.length ? (t) => st.consumed!.includes(digestOf(t)) : undefined);

export function leader(st: GoalStore, state: GameState): { id: string | null; counts: [string, number][] } {
  const counts = activeActors(state).map(([id]) => [id, goalsOf(st, id).filter((g) => g.done).length] as [string, number]);
  const top = Math.max(0, ...counts.map(([, n]) => n));
  const ids = counts.filter(([, n]) => n === top).map(([id]) => id);
  return { id: top > 0 && ids.length === 1 ? ids[0] : null, counts };
}

/** The server's lines for the narrator on this round: reactions to goals just reached, and the goals it may know (host). */
export function narratorBlock(st: GoalStore, state: GameState, round: number): string {
  if (!GOALS) return "";
  st.reactions = (st.reactions ?? []).filter((r) => r.turn >= round - 1);
  const reacts = st.reactions.filter((r) => r.turn === round - 1).map((r) => `- ${goalText("reaction", { who: nameOf(state, r.actor) })}`);
  const known = GOALS.host === "blind" ? [] : st.goals.filter((g) => !g.done && state.actors[g.actor] && (GOALS!.host === "all" || state.actors[g.actor].controlled_by === "npc"));
  const lines = known.map((g) => `- ${nameOf(state, g.actor)} secretly wants: ${g.text}`);
  const why = st.goals.filter((g) => g.reason && !g.done && state.actors[g.actor]).map((g) => `- ${nameOf(state, g.actor)} said, privately, about wanting "${g.text}": ${g.reason}`);
  return (why.length ? `\n\n## PRIVATE REASONS (written by the server; only you see it)\n${goalText("reasons")}\n${why.join("\n")}` : "") + (lines.length ? `\n\n## SECRET GOALS (written by the server; only you see it)\n${goalText("block")}\n${lines.join("\n")}` : "") + (reacts.length ? `\n\n## GOAL REACHED (written by the server)\n${reacts.join("\n")}` : "");
}

/** `/goals`: one person's own list, and after the game the standings (or always, standings: always). */
export function listFor(st: GoalStore, state: GameState, actor: string, over: boolean): string {
  const mine = goalsOf(st, actor);
  const head = mine.length ? [goalText("heading"), ...mine.map((g) => `- ${g.text} (${goalText(g.done ? "done" : "open")})`)].join("\n") : goalText("none");
  return head + (over || GOALS?.standings === "always" ? "\n\n" + standings(st, state) : "");
}

export function standings(st: GoalStore, state: GameState): string {
  const { id, counts } = leader(st, state);
  const lines = [goalText("standings"), ...counts.map(([a, n]) => `- ${nameOf(state, a)}: ${n}`)];
  lines.push(counts.every(([, n]) => n === 0) ? goalText("nobody") : id ? goalText("winner", { who: nameOf(state, id) }) : goalText("tie"));
  return lines.join("\n");
}

/** After the finale: what everyone secretly wanted, and whether they got it (code, no model). */
export function revealText(st: GoalStore, state: GameState): string {
  const rows = activeActors(state).flatMap(([id]) => goalsOf(st, id).map((g) => `- ${nameOf(state, id)}: ${g.text} (${goalText(g.done ? "done" : "open")})`));
  return [goalText("reveal"), ...(rows.length ? rows : [goalText("nobody")]), "", standings(st, state)].join("\n");
}
