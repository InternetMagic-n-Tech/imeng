import { TERMS, MODEL_ID } from "./config.js";
import { announce } from "./announce.js";
import { stateDb } from "./db-state.js";
import { readGameMd } from "./game-md.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Session } from "./types.js";

/**
 * The game's terms (config.json `terms`): a markdown file in the imeng folder, sent privately once per person and game when they are seated (or join, or start a solo game).
 * Told as an announcement to that person only: it reaches them in their private chat, or as a Discord DM, never in a reply at a shared table. Who has had it is remembered in
 * the database (`terms_sent`, expires after `remember_days`) when there is one, else in the session. There is no accept step: the person is informed.
 */
const CHUNK = 1900;

/** The terms split at paragraph breaks into messages a chat or a DM can carry. Empty when the game has no terms or the file is missing. */
export function termsChunks(text = TERMS ? readGameMd(TERMS.file) : ""): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    for (let p = para; p.length > 0; p = p.slice(CHUNK)) {
      const piece = p.slice(0, CHUNK);
      if (cur && cur.length + piece.length + 2 > CHUNK) { out.push(cur); cur = ""; }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Send the terms if this person has not had them. Returns true when they were sent now. Never for an anonymous person. */
export async function sendTerms(s: Session, who: PlayerRef, now: number): Promise<boolean> {
  if (!TERMS || who.userId === "anonymous") return false;
  const parts = termsChunks();
  if (!parts.length) return false;
  const db = stateDb(), until = now + TERMS.rememberDays * 86_400_000;
  if (db) {
    try {
      const row = await db.selectFrom("terms_sent").select("expires_at").where("user_id", "=", who.userId).where("game", "=", MODEL_ID).executeTakeFirst();
      if (row && Number(row.expires_at) > now) return false;
      await db.deleteFrom("terms_sent").where("user_id", "=", who.userId).where("game", "=", MODEL_ID).execute();
      await db.insertInto("terms_sent").values({ user_id: who.userId, game: MODEL_ID, sent_at: now, expires_at: until }).execute();
    } catch (e) { console.warn(`terms: could not record the delivery (${(e as Error).message}); falling back to the session`); if ((s.terms ??= {})[who.userId] && s.terms[who.userId] > now) return false; s.terms[who.userId] = until; }
  } else {
    const seen = (s.terms ??= {});
    if (seen[who.userId] && seen[who.userId] > now) return false;
    seen[who.userId] = until;
  }
  for (const text of parts) await announce(s, { kind: "terms", to: who.userId, text });
  return true;
}
