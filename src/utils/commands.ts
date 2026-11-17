import { contentText } from "./text.js";
import { IMAGES, OFFER_PREFIX, imageText } from "./image-config.js";
import { LINK, FREEZE } from "./identity-config.js";
import { GOALS } from "./goals-config.js";
import { OWNER } from "./owner-config.js";
import { PAY, SEATING } from "./config.js";
import { BAN, CREDIT, HANDS, HAZARDS, PHASES, AUDIENCE, SHUFFLE, AUDIT, BETTING, MULTIPLAYER, TIPS, PRODUCER } from "./config.js";
import { ELIGIBILITY } from "./eligibility-config.js";
import type { ChatMessage } from "./types.js";

/**
 * Chat commands (/draw, /portrait) and the "yes" that answers a picture offer. They are notes, not rounds: the message and the reply to it are
 * taken out of the conversation, so they never shift the turn count, rollback or edit matching. Everything here is a pure function of the chat.
 * Off (nothing is parsed) unless config.json has an `images` block.
 */

export type CommandName = "draw" | "portrait" | "link" | "freeze" | "unfreeze" | "goal" | "goals" | "keepsake" | "owner" | "successor" | "claim" | "keep" | "handover" | "reentry" | "lend" | "credit" | "bank" | "unbank" | "newcode" | "idle" | "hand" | "peek" | "odds" | "risk" | "shelter" | "move" | "end" | "seat" | "shuffle" | "audit" | "check" | "call" | "raise" | "fold" | "allin" | "start" | "nudge" | "telemetry" | "optin" | "optout" | "tip" | "deal" | "pay";
export type Command = { name: CommandName; arg: string; attached?: string } | { name: "yes"; arg: ""; attached?: undefined };

const CMD = /^\/(draw|portrait|link|freeze|unfreeze|goals|goal|keepsake|owner|successor|claim|keep|handover|reentry|lend|credit|bank|unbank|newcode|idle|hand|peek|odds|risk|shelter|start|nudge|move|end|seat|shuffle|audit|check|call|raise|fold|allin|tip|pay|deal|telemetry|optin|optout)(?:\s+([\s\S]*))?$/i;
const on = (n: CommandName): boolean => (n === "draw" || n === "portrait" ? !!IMAGES : n === "link" ? !!LINK : n === "goal" || n === "goals" ? !!GOALS : n === "keepsake" ? !!IMAGES && !!GOALS : n === "start" ? !!SEATING?.start : n === "nudge" ? PRODUCER.nudge : n === "risk" || n === "shelter" ? !!HAZARDS : n === "move" || n === "end" ? !!PHASES : n === "seat" ? !!AUDIENCE || !!SEATING : n === "shuffle" ? !!SHUFFLE : n === "audit" ? !!AUDIT : n === "tip" ? !!TIPS : n === "pay" ? !!PAY : ["check", "call", "raise", "fold", "allin", "deal"].includes(n) ? BETTING === "server" : n === "hand" ? !!HANDS : n === "peek" || n === "odds" ? !!HANDS && !!BAN : n === "idle" ? !!MULTIPLAYER?.idleVote : n === "reentry" || n === "lend" || n === "credit" || n === "bank" || n === "unbank" || n === "newcode" ? !!CREDIT : n === "optin" || n === "optout" ? !!ELIGIBILITY?.optIn : n === "owner" || n === "successor" || n === "claim" || n === "keep" || n === "handover" || n === "telemetry" ? !!OWNER : !!FREEZE);

/** "bank 4000", "bank $4,000", "bank 4000$", "put 4000 in the bank". */
const BANK_WORDS = /\bbank\s+\$?\s*(\d[\d,]*)\s*\$?|\$?(\d[\d,]*)\s*\$?\s+(?:in|into|to)\s+the\s+bank\b/i;

/** A picture attached to a message (Open WebUI sends it as an image_url part holding a data: URI). */
export function attachedImage(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const p of content as { type?: string; image_url?: { url?: string } | string }[]) {
    if (p?.type !== "image_url") continue;
    const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
    if (u) return u;
  }
  return undefined;
}

export function parseCommand(content: unknown): Command | null {
  const text = contentText(content).trim();
  if (CREDIT && !text.startsWith("/")) { // "I need to go to bed... lets bank 4000$": said in words, read by code
    const b = BANK_WORDS.exec(text);
    const amount = b && (b[1] ?? b[2]);
    if (amount) return { name: "bank", arg: "~" + amount.replace(/[,\s]/g, "") }; // only a hint: the player is shown the command to type
  }
  const m = CMD.exec(text);
  const name = m?.[1].toLowerCase() as CommandName | undefined;
  return m && name && on(name) ? { name, arg: (m[2] ?? "").trim(), attached: attachedImage(content) } : null;
}

const yesWords = (): string[] => imageText("yes").toLowerCase().split(",").map((w) => w.trim()).filter(Boolean);
export const isYes = (text: string): boolean => yesWords().includes(text.trim().toLowerCase().replace(/[.!\s]+$/u, ""));

export const isOffer = (m: ChatMessage | undefined): boolean => !!m && m.role === "assistant" && contentText(m.content).startsWith(OFFER_PREFIX);

export interface FoldedCommands { messages: ChatMessage[]; latest: Command | null }

export function foldCommands(messages: ChatMessage[]): FoldedCommands {
  if (!IMAGES && !LINK && !FREEZE && !GOALS && !OWNER && !CREDIT && !HANDS && !HAZARDS && !PHASES && !AUDIENCE && !SHUFFLE && !AUDIT && !TIPS && !PAY && !SEATING && BETTING !== "server" && !MULTIPLAYER?.idleVote && !ELIGIBILITY?.optIn) return { messages, latest: null };
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const out: ChatMessage[] = [];
  let latest: Command | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") { out.push(m); continue; }
    const next = messages[i + 1];
    const prev = messages[i - 1];
    const cmd = parseCommand(m.content) ?? (IMAGES && isYes(contentText(m.content)) && isOffer(prev) ? ({ name: "yes", arg: "" } as Command) : null);
    const asked = !!IMAGES && isOffer(next); // a natural-language request the judge answered with an offer
    if (cmd || asked) {
      if (i === lastUser && cmd) latest = cmd;
      if (next && next.role === "assistant") i++; // the reply goes with it
      continue;
    }
    out.push(m);
  }
  return { messages: out, latest };
}
