import { PRODUCER } from "./config.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Session } from "./types.js";

/**
 * The producer's nudge (config.json `producer.nudge`): /nudge <text> from the seat whose actor role is `producer.role` (the game's json declares who that is; owning the chat is not enough), in their private chat puts one note in front of the narrator on its next round, labelled as advice from someone who sees
 * everything; the table is never told. It steers tone, pacing or back-fills what the host missed; it changes no state and no rule (code owns those). At most NUDGE_MAX notes of NUDGE_CHARS wait at once.
 */
const NUDGE_MAX = 3, NUDGE_CHARS = 300;

/** The seat the game declares as producer: an actor whose role is `producer.role`. The chat owner is not one unless the game seats them so. */
function isProducer(s: Session, who: PlayerRef): boolean {
  const st = s.snapshots.at(-1), actor = s.room?.players?.[who.userId]?.actor;
  return !!st && !!actor && (st.actors[actor] as { role?: unknown } | undefined)?.role === PRODUCER.role;
}

export function nudgeCommand(arg: string, c: { session: Session; who: PlayerRef; shared: boolean }): string {
  if (!isProducer(c.session, c.who)) return "Only the producer can nudge the host.";
  if (c.shared) return "That is private: send it in your private chat with the host, never at the table.";
  const text = arg.replace(/\s+/g, " ").trim().slice(0, NUDGE_CHARS);
  if (!text) return "Use /nudge <what the host should know or do>.";
  const q = (c.session.nudges ??= []);
  if (q.length >= NUDGE_MAX) return "The host has not used your last nudges yet.";
  q.push(text);
  return "Nudge passed to the host. The table is not told.";
}

/** What the narrator is told once, then forgets. */
export function nudgeBlock(s: Session): string {
  const q = s.nudges;
  if (!q?.length) return "";
  s.nudges = [];
  return `\n\n## PRODUCER'S NUDGE (from the producer, who sees everything; the table does not know)\nWeigh it and use it if it fits: never announce it or quote it, and it changes no state or rule.\n${q.map((t) => `- ${t}`).join("\n")}`;
}
