import { GOALS, goalText } from "./goals-config.js";
import { USER_ID } from "./config.js";
import { activeActors } from "./conditions.js";
import { addGoal, digestOf, goalsOf, listFor, markDone, revealText, settle, storeOf, syncCounts } from "./goals.js";
import { inventGoal, readGoal, reachedGoals } from "./goals-judge.js";
import type { GameState, Session } from "./types.js";

/** What the engine calls: one round's goal bookkeeping, and the places a person writes or reads their goals. */

const nameOf = (state: GameState, id: string): string => String(state.actors[id]?.name || id);
const windowOpen = (state: GameState): boolean => !GOALS?.capturePhase || state.game.phase === GOALS.capturePhase;

/** After a round's narration: invent goals for NPCs that lack one, mark the goals the round reached, keep counters and phases in step. Never throws. */
export async function goalsRound(a: { session: Session; before: GameState; after: GameState; turn: number; said: string; narration: string }): Promise<GameState> {
  if (!GOALS) return a.after;
  const { session, before, after, turn } = a, st = storeOf(session);
  try {
    if (GOALS.npc === "invent" && turn >= GOALS.npcAfter) {
      for (const [id, actor] of activeActors(after)) {
        if (actor.controlled_by !== "npc" || goalsOf(st, id).length >= GOALS.min) continue;
        try {
          const text = await inventGoal(nameOf(after, id), typeof actor.description === "string" ? actor.description : "");
          if (text) addGoal(st, id, text, "invented");
        } catch (e) { console.warn(`goals: no goal invented for ${id}:`, (e as Error).message); }
      }
    }
    const open = st.goals.filter((g) => !g.done && after.actors[g.actor]).map((goal) => ({ goal, who: nameOf(after, goal.actor) }));
    if (open.length) {
      const t0 = Date.now();
      const reached = await reachedGoals(open, `${a.said}\n\nNARRATION:\n${a.narration}`);
      const done = markDone(st, after, reached, turn, `${a.said}\n${a.narration}`);
      console.log(`goals: ${open.length} open, ${done.length} reached on round ${turn} (${Date.now() - t0} ms)`);
    }
  } catch (e) { console.warn("goals: the round could not be judged:", (e as Error).message); }
  settle(after, before, st);
  return after;
}

/** A private note from a seated person (the private chat of a table): written down as a goal when the judge reads it as one. A reply text, or null when it is not a goal. */
export async function captureNote(a: { table: Session; actor: string; text: string; state: GameState; pub?: string; parts?: string[] }): Promise<string | null> {
  if (!GOALS || !windowOpen(a.state)) return null;
  const st = storeOf(a.table);
  if (goalsOf(st, a.actor).length >= GOALS.max) return null;
  let read: { goal: string; reason: string };
  try { read = await readGoal(a.text, a.pub); } catch (e) { console.warn("goals: could not read a private note:", (e as Error).message); return goalText("unread"); }
  if (!read.goal) return null;
  const out = write(a.table, a.actor, read.goal, read.reason);
  if (st.goals.some((g) => g.actor === a.actor && g.text === read.goal.replace(/\s+/g, " ").trim().slice(0, 200))) (st.consumed ??= []).push(...(a.parts ?? [a.text]).map(digestOf)); // the narrator is not shown a note that was a goal
  return out;
}

function write(table: Session, actor: string, text: string, reason = ""): string {
  const st = storeOf(table), state = table.snapshots.at(-1);
  const r = addGoal(st, actor, text, "player", reason);
  if (state) syncCounts(state, st);
  return "error" in r ? goalText(r.error === "full" ? "full" : "empty") : goalText("saved", { goal: r.goal.text });
}

export interface Place { s: Session; state: GameState; actor: string }
/** Where a person's goals live: a solo chat, or the table of a private chat. Null at the table itself (shared) or when they have no character. */
export function placeOf(c: { mp: "solo" | "table" | "private"; solo: Session; table: Session | null; userId: string }): Place | null {
  if (c.mp === "table") return null;
  const s = c.mp === "private" && c.table ? c.table : c.solo;
  const state = s.snapshots.at(-1);
  const actor = c.mp === "private" ? s.room?.players[c.userId]?.actor : USER_ID;
  return state && actor && state.actors[actor] ? { s, state, actor } : null;
}

export interface GoalCmdCtx { name: "goal" | "goals"; arg: string; mp: "solo" | "table" | "private"; solo: Session; table: Session | null; userId: string }

/** /goal <text> writes a goal down, /goals lists your own. Only in a private place: a solo chat or the private chat of a table. */
export function goalCommand(c: GoalCmdCtx): string {
  if (c.mp === "table") return goalText("not_here");
  const p = placeOf(c);
  if (!p) return goalText("none");
  const { s, state, actor } = p;
  if (c.name === "goals") return listFor(storeOf(s), state, actor, s.wrapUp !== undefined);
  if (!windowOpen(state)) return goalText("not_now");
  const m = /^(.*?)\s+(?:because|since)\s+(.+)$/is.exec(c.arg);
  return m ? write(s, actor, m[1], m[2]) : write(s, actor, c.arg);
}

/** The reveal told once after the finale (on the first round after it): what everyone secretly wanted. Empty when off, told, or nothing to tell. */
export function takeReveal(session: Session, state: GameState): string {
  if (!GOALS || GOALS.reveal === "never") return "";
  const st = storeOf(session);
  if (st.revealed || !st.goals.length) return "";
  st.revealed = true;
  return revealText(st, state);
}
