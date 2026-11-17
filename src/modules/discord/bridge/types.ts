/** What the bridge needs from Discord, kept small so the whole bridge can be tested without a gateway. discord.js implements it (discordjs.ts); tests fake it. */

export interface DMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  /** Milliseconds; message ids (snowflakes) are what ordering uses. */
  createdAt: number;
  /** The message this one replies to. */
  replyToId: string | null;
  /** The author of that message (known for the message that just arrived). */
  replyToAuthorId?: string | null;
  /** Ids of the users mentioned. */
  mentions: string[];
  isDM: boolean;
  /** Files attached to the message (only the pending message's pictures are used). */
  attachments?: { url: string; contentType: string | null; size: number }[];
  /** For a thread: the channel it belongs to. */
  parentChannelId?: string | null;
}

export interface DiscordApi {
  /** The latest messages of a channel (any order). */
  fetchHistory(channelId: string, limit: number): Promise<DMessage[]>;
  /** Send a message, as a reply to `replyTo` when given, without pinging anyone. Returns its id. */
  send(channelId: string, text: string, replyTo?: string): Promise<string>;
  /** Send a picture as an attachment (a reply to `replyTo` when given). Returns its message id. */
  sendImage(channelId: string, bytes: Uint8Array, name: string, replyTo?: string): Promise<string>;
  /** A direct message to one person. Rejects when they do not accept messages from the bot. */
  dm(userId: string, text: string): Promise<void>;
  edit(channelId: string, messageId: string, text: string): Promise<void>;
  typing(channelId: string): Promise<void>;
  /** Hide a server channel from one person (they are out of it), and give it back. Both reject in a DM or without the permission. */
  kick(channelId: string, userId: string): Promise<void>;
  unkick(channelId: string, userId: string): Promise<void>;
}

export interface BotClient {
  /** The bot's own user id. */
  readonly selfId: string;
  readonly api: DiscordApi;
  onMessage(cb: (m: DMessage) => void): void;
  /** The bot was removed from, or lost, these channels (a server, a channel, a thread). Optional: a client that cannot tell does not call it. */
  onLeave?(cb: (e: { channelIds: string[] }) => void): void;
  /** The bot was added to these channels. */
  onJoin?(cb: (e: { channelIds: string[] }) => void): void;
  login(): Promise<void>;
  destroy(): Promise<void>;
}

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage { role: "user" | "assistant"; content: string | ChatPart[] }
