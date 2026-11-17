import type { DMessage } from "./types.js";

/** Should this Discord message be answered, and which conversation is it part of? Pure: no Discord, no network. */

export interface RouteBot { name: string; guilds?: string[]; channels: "all" | string[]; dms: boolean; answerWhen: "mention" | "all" }
export type Scope = "user" | "channel";

export type Decision =
  | { answer: false; reason: string }
  /** `chatKey`: the conversation's id as the proxy sees it; `text`: the message without the bot's own mention. */
  | { answer: true; chatKey: string; text: string };

const mentionOf = (selfId: string): RegExp => new RegExp(`<@!?${selfId}>`, "g");
export const stripMention = (content: string, selfId: string): string => content.replace(mentionOf(selfId), "").replace(/[ \t]{2,}/g, " ").trim();

/**
 * Discord has no <private>. A spoiler that holds only code-like text (inline backticks, or a fenced block) is the stand-in: everyone in the channel can
 * read it, but the game treats it as private. Any other spoiler (a spoilered gif, plain text) is left alone for the game to decide.
 */
const SPOILER_CODE = /\|\|\s*(?:```(?:[\w+-]*\n)?([\s\S]*?)```|`([^`\n]+)`)\s*\|\|/g;
export const spoilerPrivate = (text: string): string => text.replace(SPOILER_CODE, (_m, block?: string, inline?: string) => `<private>${(block ?? inline ?? "").trim()}</private>`);

/** The id of a conversation: one per person (scope user) or one per channel (scope channel); a direct message is always one person. */
export function chatKeyFor(bot: string, scope: Scope, m: Pick<DMessage, "channelId" | "authorId" | "isDM">): string {
  if (m.isDM) return `discord:${bot}:dm:${m.authorId}`;
  return scope === "channel" ? `discord:${bot}:${m.channelId}` : `discord:${bot}:${m.channelId}:${m.authorId}`;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
export const MAX_PICTURES = 3;
const HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
/** The pictures of a message the bridge will fetch: image types only, from Discord's own file hosts, within the size cap. */
export function pictures(m: DMessage): { url: string; contentType: string }[] {
  return (m.attachments ?? []).flatMap((a) => {
    try {
      const u = new URL(a.url);
      return u.protocol === "https:" && HOSTS.has(u.hostname) && a.contentType && IMAGE_TYPES.has(a.contentType) && a.size > 0 && a.size <= MAX_PICTURE_BYTES ? [{ url: a.url, contentType: a.contentType }] : [];
    } catch { return []; }
  }).slice(0, MAX_PICTURES);
}

export function decide(bot: RouteBot, scope: Scope, m: DMessage, selfId: string): Decision {
  if (m.authorIsBot || m.authorId === selfId) return { answer: false, reason: "a bot's own or another bot's message" };
  const text = spoilerPrivate(stripMention(m.content, selfId)) || (pictures(m).length ? "(sent a picture)" : "");
  if (!text) return { answer: false, reason: "nothing but a mention" };
  if (m.isDM) return bot.dms ? { answer: true, chatKey: chatKeyFor(bot.name, scope, m), text } : { answer: false, reason: "direct messages are off for this bot" };
  if (bot.guilds && bot.guilds.length && (!m.guildId || !bot.guilds.includes(m.guildId))) return { answer: false, reason: "a server this bot does not serve" };
  if (bot.channels !== "all" && !bot.channels.includes(m.channelId) && !(m.parentChannelId && bot.channels.includes(m.parentChannelId))) return { answer: false, reason: "a channel this bot does not serve" };
  if (bot.answerWhen === "mention" && !m.mentions.includes(selfId) && m.replyToAuthorId !== selfId) return { answer: false, reason: "not addressed to the bot (no mention, not a reply to it)" };
  return { answer: true, chatKey: chatKeyFor(bot.name, scope, m), text };
}
