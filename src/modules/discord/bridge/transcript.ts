import { stripMention, spoilerPrivate } from "./route.js";
import type { ChatMessage, DMessage } from "./types.js";
import type { Scope } from "./route.js";

/**
 * Rebuild a conversation from a Discord channel. Discord sends no chat history, so the bridge reads the channel and keeps only what belongs to the
 * conversation: the messages the bot answered (it replies to them, so the pairing is explicit) plus the new one. In a public channel that makes every
 * person's conversation with the bot a 1:1 one. The reply is however many Discord messages the answer was split into, joined back into one.
 * Context the message points at (the message it replies to, what the bot said to someone it mentions) is NOT put in the transcript, so the saved
 * fingerprints never see it; it is returned separately and travels as background (X-Game-Context).
 */

export interface TranscriptOpts {
  history: DMessage[];
  pending: DMessage;
  /** The pending message without the bot's mention. */
  pendingText: string;
  selfId: string;
  scope: Scope;
  mergeContext: "mentions" | "reply" | "off";
}

export interface Transcript { messages: ChatMessage[]; context: string }

const idCmp = (a: string, b: string): number => { try { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; } catch { return a.localeCompare(b); } };
const quote = (t: string, max = 300): string => { const s = t.replace(/\s+/g, " ").trim(); return `"${s.length > max ? s.slice(0, max) + "…" : s}"`; };
const CONTEXT_MAX = 1500;

export function buildTranscript(o: TranscriptOpts): Transcript {
  const sorted = o.history.filter((m) => m.id !== o.pending.id).sort((a, b) => idCmp(a.id, b.id));
  // what the bot said to which message (an answer may be several Discord messages)
  const answers = new Map<string, string[]>();
  for (const m of sorted) if (m.authorId === o.selfId && m.replyToId && m.content.trim()) answers.set(m.replyToId, [...(answers.get(m.replyToId) ?? []), m.content.trim()]);

  const mine = (m: DMessage): boolean => !m.authorIsBot && (o.scope === "channel" || m.authorId === o.pending.authorId);
  const messages: ChatMessage[] = [];
  for (const m of sorted) {
    if (!mine(m)) continue;
    const reply = answers.get(m.id);
    if (!reply && !m.isDM) continue; // not addressed to the bot: not part of the conversation
    messages.push({ role: "user", content: spoilerPrivate(stripMention(m.content, o.selfId)) });
    if (reply) messages.push({ role: "assistant", content: reply.join("\n") });
  }
  messages.push({ role: "user", content: o.pendingText });

  // background from the message the player is pointing at
  const lines: string[] = [];
  if (o.mergeContext !== "off") {
    if (o.pending.replyToId) {
      const target = sorted.find((m) => m.id === o.pending.replyToId);
      if (target && target.authorId !== o.selfId) lines.push(`The message being replied to, from ${target.authorName}: ${quote(stripMention(target.content, o.selfId))}`);
      else if (target) lines.push(`The message being replied to is one of your own earlier replies: ${quote(target.content)}`);
    }
    if (o.mergeContext === "mentions" && o.scope === "user") {
      const others = [...new Set(o.pending.mentions)].filter((id) => id !== o.selfId && id !== o.pending.authorId);
      for (const id of others) {
        const theirs = sorted.filter((m) => !m.authorIsBot && m.authorId === id && answers.has(m.id)).slice(-2);
        if (!theirs.length) continue;
        const who = theirs[0].authorName;
        lines.push(`Earlier in this channel you spoke with ${who} (mentioned in this message): ${theirs.map((m) => `${who} said ${quote(stripMention(m.content, o.selfId))} and you replied ${quote(answers.get(m.id)!.join(" "))}`).join("; then ")}`);
      }
    }
  }
  let context = lines.join("\n");
  if (context.length > CONTEXT_MAX) context = context.slice(0, CONTEXT_MAX) + "…";
  return { messages, context };
}
