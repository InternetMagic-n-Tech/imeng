import { HANDS } from "./config.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Session } from "./types.js";

/**
 * /hand (private_hands): a player's own cards, shown only in their private chat. The shared chat refuses and says where to ask, so a hand never appears where the table can read it.
 * The cards come from the actor's `field` in the state; the narrator is told in the prompt never to write them in the shared chat.
 */
const TEXTS: Record<string, string> = {
  shared: "Hands are private. Ask in your private chat with the dealer: type /hand there.",
  not_seated: "You are not seated at this table.", none: "You have no cards right now.", yours: "Your hand: {cards}.",
};
const say = (k: string, v: Record<string, string> = {}): string => (TEXTS[k] ?? k).replace(/\{(\w+)\}/g, (_m, x: string) => v[x] ?? "");

export function handCommand(s: Session, who: PlayerRef, isPrivate: boolean): string {
  if (!HANDS) return "";
  if (!isPrivate) return say("shared"); // not even a count of cards: nothing about a hand is said where others read
  const me = s.room?.players[who.userId];
  if (!me) return say("not_seated");
  const cards = s.snapshots.at(-1)?.actors[me.actor]?.[HANDS.field];
  const list = Array.isArray(cards) ? cards.map(String).filter(Boolean) : [];
  return list.length ? say("yours", { cards: list.join(", ") }) : say("none");
}
