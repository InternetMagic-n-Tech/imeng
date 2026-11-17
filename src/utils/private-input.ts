import { contentText } from "./text.js";
import { PRIVATE_GUIDANCE } from "./config.js";
import type { ChatMessage } from "./types.js";

/**
 * `<private>...</private>` in what a player writes (Open WebUI first class; the Discord bridge turns its spoiler-and-code signal into the same tag).
 * A message that is only private is a note, not a round: it is taken out of the conversation (with the assistant reply that followed it) so it never
 * shifts the turn count, rollback or edit matching. A message with public text beside the private part is a round; its private part reaches the
 * narrator as a PRIVATE line (solo) or a note (a table). Everything here is a pure function of the chat, so every turn derives the same result.
 */

const TAG = /<private>([\s\S]*?)<\/private>/gi;

export const splitPrivate = (text: string): { pub: string; priv: string[] } => ({
  pub: text.replace(TAG, "").trim(),
  priv: [...text.matchAll(TAG)].map((m) => m[1].trim()).filter(Boolean),
});

export const PRIVATE_LINE = "PRIVATE (the player's own: hidden from the characters and from the other players; use it, never reveal it):";

export interface Folded {
  messages: ChatMessage[];
  /** The private parts of the latest user message, if it had any. */
  latest: string[];
  /** The latest user message is only private: it is a note and starts no round. */
  latestOnly: boolean;
}

/**
 * `inline`: a private part stays with its message as a PRIVATE line (solo). Without it (a table) the private part of a message is dropped from the
 * conversation; the caller files the latest one as a note. `skip` names private text that was taken as a goal: the narrator is not shown it.
 */
export function foldPrivate(messages: ChatMessage[], inline: boolean, skip?: (text: string) => boolean): Folded {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const out: ChatMessage[] = [];
  const pending: string[] = [];
  let skipReply = false, latest: string[] = [], latestOnly = false;
  messages.forEach((m, i) => {
    if (m.role !== "user") {
      if (m.role === "assistant" && skipReply) { skipReply = false; return; } // the acknowledgement of a private-only message
      out.push(m);
      return;
    }
    skipReply = false;
    const { pub, priv } = splitPrivate(contentText(m.content));
    if (i === lastUser) { latest = priv; latestOnly = priv.length > 0 && !pub; }
    if (priv.length && !pub) { // a note: out of the conversation, carried to the next real message
      if (i !== lastUser) { pending.push(...priv.filter((x) => !skip?.(x))); skipReply = true; }
      return;
    }
    if (!priv.length && !pending.length) { out.push(m); return; }
    const lines = inline ? [...pending, ...priv.filter((x) => !skip?.(x))].map((p) => `${PRIVATE_LINE} ${p}`) : [];
    pending.length = 0;
    out.push({ ...m, content: [priv.length ? pub : contentText(m.content), ...lines].join("\n\n") });
  });
  return { messages: out, latest, latestOnly };
}

/** How this game uses the private channel (config.json private_guidance), told to the narrator on a round that has a private part. */
export const privateBlock = (present: unknown): string => (present && PRIVATE_GUIDANCE ? `\n\n## THE PRIVATE CHANNEL (written by the server)\n${PRIVATE_GUIDANCE}` : "");
