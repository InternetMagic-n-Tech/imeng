import { WRAP_UP, SHOW_CLOCK, USER_ID, CONTEXT_MAX_ROUNDS } from "./config.js";
import { estimateTokens } from "./compact.js";
import { contentText } from "./text.js";
import type { ChatMessage, GameState, Session } from "./types.js";

/*
 * The escape hatch. Compaction can only shrink so much: if the prompt is still near the model's limit, the
 * next answer could be cut off or the model could lose the thread. When the prompt passes `wrap_up.at_tokens`,
 * the narrator is told, with the game's own wording, to close the game gracefully on that turn. Every turn
 * after that it is told the game is over, or, with `over_reply`, the server replies with that fixed text itself.
 * The server decides when; the model only writes the ending.
 * (The block goes into the narrator's prompt only; a rolled-back player gets a fresh decision.)
 */
export function wrapUpStatus(session: Session, turn: number, systemChars: number, shown: ChatMessage[], state?: GameState): { text: string; over: boolean; final?: boolean } {
  const none = { text: "", over: false };
  if (!WRAP_UP) return none;
  if (session.wrapUp !== undefined && turn < session.wrapUp) { session.wrapUp = undefined; session.wrapText = undefined; } // the player went back
  if (session.wrapUp === undefined && WRAP_UP.on_exit && state) {
    // The game ends when the person typing (or everyone) is out: this reply is the finale, then the game is over.
    const out = new Set(state.game.exited_game.map((e) => e.id));
    const ended = WRAP_UP.on_exit === "user" ? out.has(USER_ID) : Object.keys(state.actors).every((id) => out.has(id));
    if (ended) { session.wrapUp = turn; console.log(`the game has ended (${WRAP_UP.on_exit === "user" ? "the player is out" : "everyone is out"}): telling the narrator to close it`); }
  }
  // The show clock: at the total the next reply is the finale; from the first warning mark the narrator is told how long is left.
  const mins = typeof state?.game.show_minutes === "number" ? state.game.show_minutes : 0;
  if (SHOW_CLOCK && session.wrapUp === undefined && mins >= SHOW_CLOCK.total) { session.wrapUp = turn; console.log(`the show clock ran out (${mins} of ${SHOW_CLOCK.total} minutes): telling the narrator to close the show`); }
  if (SHOW_CLOCK && session.wrapUp === undefined && SHOW_CLOCK.warnAt.length && mins >= SHOW_CLOCK.warnAt[0]!) {
    return { text: `\n\n## WRAP UP SOON (about ${Math.max(1, Math.round(SHOW_CLOCK.total - mins))} minute(s) of show left)\n${WRAP_UP.soon_text}`, over: false };
  }
  // The game's own budget can wait for compaction (turn_budget); the machine ceiling (env) never does.
  const budgetOn = WRAP_UP.turn_budget === "hard" || !session.summary;
  if (session.wrapUp === undefined && CONTEXT_MAX_ROUNDS > 0 && turn >= CONTEXT_MAX_ROUNDS) {
    session.wrapUp = turn;
    console.warn(`CONTEXT_MAX_ROUNDS reached (round ${turn} of ${CONTEXT_MAX_ROUNDS}): telling the narrator to close the game`);
  }
  if (session.wrapUp === undefined && budgetOn && WRAP_UP.at_turn > 0 && turn >= WRAP_UP.at_turn) {
    session.wrapUp = turn;
    console.log(`turn budget reached (turn ${turn} of ${WRAP_UP.at_turn}): telling the narrator to close the game`);
  }
  if (session.wrapUp === undefined && WRAP_UP.at_tokens > 0) {
    const chars = systemChars + shown.reduce((n, m) => n + contentText(m.content).length, 0);
    if (estimateTokens(chars) >= WRAP_UP.at_tokens) {
      session.wrapUp = turn;
      console.warn(`context is nearly full (about ${estimateTokens(chars)} tokens): telling the narrator to close the game`);
    }
  }
  if (session.wrapUp === undefined && budgetOn && WRAP_UP.at_turn > 0 && WRAP_UP.soon_turns > 0 && turn >= WRAP_UP.at_turn - WRAP_UP.soon_turns) {
    return { text: `\n\n## WRAP UP SOON (the game ends in ${WRAP_UP.at_turn - turn} turn(s))\n${WRAP_UP.soon_text}`, over: false };
  }
  if (session.wrapUp === undefined) return none;
  if (session.wrapUp === turn) return { text: `\n\n## WRAP UP (this is the final turn)\n${session.wrapText || WRAP_UP.text}`, over: false, final: true };
  // After the final turn: with `over_reply` the server answers by itself and the model is not called at all.
  return { text: `\n\n## GAME OVER\n${WRAP_UP.after_text}`, over: !!WRAP_UP.over_reply };
}
