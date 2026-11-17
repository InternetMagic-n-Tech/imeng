import { judgeJSON } from "./judge.js";
import { applyOps, judgeView } from "./state.js";
import { evalCondition } from "./conditions.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { GAME_TURN, TURN_EVENTS } from "./config.js";
import type { Condition } from "./conditions.js";
import type { Effect, GameState, Session } from "./types.js";

/**
 * Game turns (see docs/IMENG-MAKING.md, "Game turns"). A game turn is a beat the game defines (a show round, a quarter), apart from the chat round:
 * the round is the key for rollback and edits, the game turn is what the game's rules and events count. The count lives in the state
 * (`game.game_turn`, with `game.fired` and `game.effects`), so a rollback restores it. The judge only classifies; code does everything else.
 */

const LOG_CHARS = 6000;

const ADVANCE_SYSTEM = (rule: string, word: string): string => `You decide whether a game ${word} has just completed in a shared game. A ${word} is: ${rule || `one full pass of the game as its rules describe it`}
You get the CURRENT ${word.toUpperCase()} number, the ACTIVE EFFECTS (timed things on characters), everything said and narrated since the last ${word} (public and private), and the STATE CHANGES of the latest round. Be consistent with the characters and the story; when you are not sure, answer false. Output ONLY JSON: {"advanced":true|false,"released":["ids of active effects that ended in the story"]}
${UNTRUSTED_NOTICE}`;

const word = (): string => GAME_TURN?.word ?? "turn";
const turnOf = (s: GameState): number => Math.max(0, Math.floor(Number(s.game.game_turn) || 0));
export const effectsOf = (s: GameState): Effect[] => (Array.isArray(s.game.effects) ? (s.game.effects as Effect[]) : []);

/** What changed between two states: plain actor fields and game fields, one line each (no secrets: this is the recorded state). */
function diff(prev: GameState, cur: GameState): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  for (const [id, a] of Object.entries(cur.actors)) for (const [k, v] of Object.entries(a ?? {})) { const o = prev.actors[id]?.[k]; if (!same(o, v) && k !== "history") out.push(`${id}.${k}: ${JSON.stringify(o ?? null)} -> ${JSON.stringify(v)}`); }
  for (const [k, v] of Object.entries(cur.game)) if (!["events", "rules", "exited_game", "fired", "effects", "turn"].includes(k) && !same(prev.game[k], v)) out.push(`game.${k}: ${JSON.stringify(prev.game[k] ?? null)} -> ${JSON.stringify(v)}`);
  return out.slice(0, 40);
}

/** Keep what was said since the last game turn, newest last, within a size; drop anything from a round that was rolled back. */
function remember(session: Session, round: number, text: string): string {
  const log = (session.turnLog ?? []).filter((e) => e.round < round);
  log.push({ round, text });
  let total = log.reduce((n, e) => n + e.text.length, 0);
  while (log.length > 1 && total > LOG_CHARS) total -= log.shift()!.text.length;
  session.turnLog = log;
  return log.map((e) => `[round ${e.round}]\n${e.text}`).join("\n\n").slice(-LOG_CHARS);
}

export interface TurnArgs { session: Session; before: GameState; after: GameState; round: number; said: string; narration: string }

/** Decide whether a game turn passed; if it did, count it, expire effects and fire the events. Returns the state to record. Never throws. */
export async function runGameTurn({ session, before, after, round, said, narration }: TurnArgs): Promise<GameState> {
  if (!GAME_TURN) return after;
  const state = after;
  const prev = turnOf(before);
  state.game.game_turn = prev;
  const log = remember(session, round, `${said}\n\nNARRATION:\n${narration}`);
  let advanced = GAME_TURN.advance === "round";
  if (GAME_TURN.advance === "field") advanced = Number(state.game[GAME_TURN.field]) > Number(before.game[GAME_TURN.field] ?? -Infinity);
  if (GAME_TURN.advance === "judged") {
    try {
      const effects = effectsOf(state);
      const content = `CURRENT ${word().toUpperCase()}: ${prev}\nACTIVE EFFECTS: ${untrusted(JSON.stringify(effects.map((e) => ({ id: e.id, who: e.who, text: e.text, until: e.until }))))}\nSINCE THE LAST ${word().toUpperCase()}:\n${untrusted(log)}\nSTATE CHANGES:\n${untrusted(diff(before, state).join("\n") || "none")}\nSTATE:\n${untrusted(JSON.stringify(judgeView(state)))}`;
      const v = await judgeJSON(ADVANCE_SYSTEM(GAME_TURN.rule, word()), content, "game_turn", 200);
      advanced = v?.advanced === true;
      const gone = new Set(Array.isArray(v?.released) ? v.released.map(String) : []);
      if (gone.size) state.game.effects = effects.filter((e) => !gone.has(e.id));
    } catch (e) { console.warn("game turn judge failed (no advance):", (e as Error).message); advanced = false; }
  }
  if (!advanced) return state;
  const now = prev + 1;
  state.game.game_turn = now;
  session.turnLog = [];
  if (effectsOf(state).length) state.game.effects = effectsOf(state).filter((e) => e.until > now);
  console.log(`${word()} ${now} of the game begins (after round ${round})`);
  return fireEvents(session, state, now, round);
}

function fireEvents(session: Session, state: GameState, now: number, round: number): GameState {
  let cur = state;
  const fired = new Set<string>(Array.isArray(cur.game.fired) ? (cur.game.fired as string[]) : []);
  for (const e of TURN_EVENTS) {
    const key = e.at ? e.id : `${e.id}@${now}`;
    if (fired.has(key) || !(e.at ? e.at === now : now % e.every === 0)) continue;
    if (e.if !== undefined && !evalCondition(e.if as Condition, cur)) continue;
    fired.add(key);
    const ops = Object.entries(e.set).map(([path, value]) => ({ op: "set", path, value }));
    if (ops.length) { const r = applyOps(cur, ops); cur = r.state; for (const s of r.skipped) console.warn(`turn event ${e.id}: ${s}`); }
    if (e.end) { session.wrapUp = round + 1; session.wrapText = e.text || undefined; console.log(`turn event ${e.id}: the game ends on the next round`); }
    else if (e.text) (session.pendingEvents ??= []).push({ round, text: e.text });
  }
  cur.game.fired = [...fired].slice(-200);
  cur.game.game_turn = now;
  return cur;
}

/** What the narrator is told about game turns on this round: where the game is, timed effects, and events that just fired. */
export function turnBlock(session: Session, state: GameState, round: number): string {
  if (!GAME_TURN) return "";
  const now = turnOf(state), w = word();
  const effects = effectsOf(state);
  const events = (session.pendingEvents ?? []).filter((e) => e.round === round - 1).map((e) => e.text);
  session.pendingEvents = (session.pendingEvents ?? []).filter((e) => e.round >= round - 1);
  const lines = [`It is ${w} ${now} of the game.`, ...effects.map((e) => `- ${state.actors[e.who]?.name ?? e.who}: ${e.text} (until ${w} ${e.until}; the story may end it sooner)`), ...events.map((t) => `EVENT: ${t}`)];
  return `\n\n## GAME ${w.toUpperCase()} (written by the server)\n${lines.join("\n")}`;
}
