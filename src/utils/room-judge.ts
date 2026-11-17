import { judgeJSON } from "./judge.js";
import { parseDurationMs, parseGameDuration } from "./durations.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import type { MultiplayerConfig } from "./config.js";
import type { Room, RoomPlayer } from "./types.js";
import type { Verdict } from "./multiplayer.js";

/**
 * The judge model reads messages in a shared game (config.json: multiplayer.judge): is it a move, is it not their moment, is it table talk,
 * is the person stepping away or back, did they leave a standing instruction ("if I do not answer in 5 days, assume ..."). It only classifies; the code applies the result, and any
 * failure means "no verdict" (the plain rules of the turn policy then apply).
 */

const SYSTEM = `You read one message in a shared game with several real players. Decide what the message is. Output ONLY JSON:
{"kind":"act","awaiting":[],"standing":null,"cancel_standing":false}
kind: "act" = a move in the story (what their character says or does now); "hold" = a move, but not their moment yet according to the TURN RULE; "chat" = talk between the players, outside the story; "pause" = the person says they must step away (a break, a call, privacy, anything: never ask why and never write the reason); "return" = they say they are back.
awaiting: the names of the players the story is now waiting on, from the TURN RULE and the last narration ([] when it waits on nobody).
standing: only when the message (usually a private note) says what their character should do if they do not answer in time, for example "if I do not reply in 5 real days assume I figure it out": {"after_real":"5 days" or null,"after_game":"3 days" or null,"action":"what their character does"}. Otherwise null. Never invent one. "cancel_standing": true when they withdraw such an instruction.
${UNTRUSTED_NOTICE}`;

const KINDS = new Set(["act", "hold", "chat", "pause", "return"]);

/** Should this message be read by the judge at all? (A lone player has nothing to be judged against.) */
export const needsJudge = (room: Room, cfg: MultiplayerConfig): boolean => cfg.judge && room.order.length >= 2;

export interface JudgeArgs { text: string; secret: string; narration: string; me: RoomPlayer }

/** The judge's reading of one message, or null when there is none (judge down, nonsense answer). */
export async function judgeMessage(room: Room, cfg: MultiplayerConfig, a: JudgeArgs): Promise<Verdict | null> {
  const roster = room.order.map((id) => ({ name: room.players[id].name, away: !!room.players[id].away }));
  const content = `TURN RULE (${cfg.turns}): ${cfg.turnRule || (cfg.turns === "ready" ? "everybody acts together, then says ready" : cfg.turns === "token" ? "only the player whose turn it is acts" : "any player may act at any time")}\nPLAYERS: ${untrusted(JSON.stringify(roster))}\nSPEAKER: ${untrusted(a.me.name)}\nLAST NARRATION: ${untrusted(a.narration.slice(-700))}\n<player_message>${untrusted(a.text)}</player_message>${a.secret ? `\n<private_message>${untrusted(a.secret)}</private_message>` : ""}`;
  let j: any;
  try { j = await judgeJSON(SYSTEM, content, "room_message", 200); } catch { return null; }
  if (!j || typeof j !== "object" || !KINDS.has(j.kind)) return null;
  const names = new Set(roster.map((r) => r.name.toLowerCase()));
  const awaiting = Array.isArray(j.awaiting) ? j.awaiting.filter((n: unknown): n is string => typeof n === "string" && names.has(n.toLowerCase())) : undefined;
  const s = j.standing && typeof j.standing === "object" ? j.standing : null;
  const afterRealMs = s ? parseDurationMs(s.after_real) ?? undefined : undefined;
  const afterGame = s && cfg.clock ? parseGameDuration(s.after_game, cfg.clock.unit) ?? undefined : undefined;
  const action = s && typeof s.action === "string" ? s.action.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const standing = action && (afterRealMs !== undefined || afterGame !== undefined) ? { afterRealMs, afterGame, action } : null;
  return { kind: j.kind, awaiting, standing, cancelStanding: j.cancel_standing === true };
}
