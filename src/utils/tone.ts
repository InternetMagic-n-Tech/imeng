import { judgeJSON } from "./judge.js";
import { OWNER } from "./owner-config.js";
import { announce } from "./announce.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Session } from "./types.js";

/**
 * Tone as a condition of being a successor (owner.tone). A person who has spoken `every` times is sent a private notice asking if they want to be considered; only a yes
 * (`/successor accept`) lets anything be judged. Every `every` more turns the small judge reads their last few messages and returns one number from 0 (hostile, derailing) to 1
 * (kind, level-headed, on tone with the room). Only that number is kept: the messages are dropped as soon as they are read. To be named a successor, or suggested as one,
 * a person must have accepted AND have a number at or above `owner.tone.min`.
 */
const PROMPT = `You rate how one person behaves in a group chat, from their last few messages. Judge politeness, level-headedness, and whether they follow the tone of the room (a game): 0 is hostile, spiteful or derailing, 1 is kind, calm and constructive. Ignore the topic of the game itself (a villain's lines in a story are not rudeness). Output ONLY JSON: {"tone": <number from 0 to 1>}`;
const KEEP = 6, CUT = 300;

export const eligible = (p: { consent?: string; tone?: number } | undefined): boolean => !OWNER?.tone || (p?.consent === "yes" && typeof p.tone === "number" && p.tone >= OWNER.tone.min);

const INVITE = "You have been speaking here a while, so you may be asked to take over this room as its owner one day. To be considered, send /successor accept. Only a kindness-and-calm score from a small model is kept, never your messages, and you can say /successor decline at any time.";

/** Called for each spoken line of a person at a table. Cheap: most calls only count and remember. Never throws. */
export async function noteSpoken(session: Session, who: PlayerRef, text: string, now = Date.now()): Promise<void> {
  const T = OWNER?.tone, own = session.own;
  if (!T || !own || !session.owner || session.owner.userId === who.userId || who.userId === "anonymous") return;
  const p = own.people[who.userId];
  if (!p || p.consent === "no") return;
  const msgs = p.msgs ?? 0;
  if (p.consent === undefined) {
    if (msgs >= T.every) { p.consent = "pending"; await announce(session, { kind: "successor_invite", to: who.userId, text: INVITE, at: now }); }
    return;
  }
  if (p.consent !== "yes") return;
  (p.recent ??= []).push(text.replace(/\s+/g, " ").slice(0, CUT));
  p.recent = p.recent.slice(-KEEP);
  if (msgs - (p.toneAt ?? 0) < T.every || p.recent.length < Math.min(T.every, 3)) return; // enough turns since the last rating, and enough of their words to judge
  try {
    const v = await judgeJSON(`${PROMPT}\n\n${UNTRUSTED_NOTICE}`, p.recent.map((m, i) => `<message n="${i + 1}">${untrusted(m)}</message>`).join("\n"), "tone", 60, OWNER?.tone?.judge);
    const n = Number(v?.tone);
    if (Number.isFinite(n)) { p.tone = Math.min(1, Math.max(0, n)); p.toneAt = msgs; p.recent = []; }
  } catch (e) { console.warn(`tone judge failed (no score): ${(e as Error).message}`); }
}
