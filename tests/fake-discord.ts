import type { BotClient, DMessage, DiscordApi } from "../src/modules/discord/bridge/types.js";

/** A pretend Discord for one bot: channels of messages, a clock of ids, and a record of what the bridge did. */
export class FakeDiscord implements BotClient {
  readonly selfId: string;
  private handlers: ((m: DMessage) => void)[] = [];
  channels = new Map<string, DMessage[]>();
  private next = 1000n;
  typings = 0;
  dms: { userId: string; text: string }[] = [];
  failDm = false;
  pictures: { channelId: string; name: string; size: number }[] = [];
  failSend = false;
  kicked: { channelId: string; userId: string }[] = [];
  restored: { channelId: string; userId: string }[] = [];
  destroyed = false;
  loggedIn = false;
  constructor(selfId = "900") { this.selfId = selfId; }

  private add(m: Omit<DMessage, "id" | "createdAt">): DMessage {
    const msg: DMessage = { ...m, id: String(this.next++), createdAt: Date.now() };
    const list = this.channels.get(m.channelId) ?? [];
    list.push(msg); this.channels.set(m.channelId, list);
    return msg;
  }
  /** A person writes in a channel (the bridge is told). */
  say(channelId: string, authorId: string, authorName: string, content: string, o: Partial<DMessage> = {}): DMessage {
    const m = this.add({ channelId, guildId: o.isDM ? null : "g1", authorId, authorName, authorIsBot: false, content, replyToId: null, mentions: [], isDM: false, ...o });
    for (const h of this.handlers) h(m);
    return m;
  }
  /** Write something the bridge must not hear (another bot, an earlier time). */
  quietly(channelId: string, authorId: string, authorName: string, content: string, o: Partial<DMessage> = {}): DMessage {
    return this.add({ channelId, guildId: "g1", authorId, authorName, authorIsBot: false, content, replyToId: null, mentions: [], isDM: false, ...o });
  }
  /** The bot's messages in a channel, oldest first. */
  botMessages(channelId: string): DMessage[] { return (this.channels.get(channelId) ?? []).filter((m) => m.authorId === this.selfId); }
  find(channelId: string, id: string): DMessage | undefined { return (this.channels.get(channelId) ?? []).find((m) => m.id === id); }

  private leaveHandlers: ((e: { channelIds: string[] }) => void)[] = [];
  private joinHandlers: ((e: { channelIds: string[] }) => void)[] = [];
  onLeave(cb: (e: { channelIds: string[] }) => void): void { this.leaveHandlers.push(cb); }
  onJoin(cb: (e: { channelIds: string[] }) => void): void { this.joinHandlers.push(cb); }
  /** The bot is removed from channels. */
  leave(...channelIds: string[]): void { for (const h of this.leaveHandlers) h({ channelIds }); }
  /** The bot is added to channels. */
  join(...channelIds: string[]): void { for (const h of this.joinHandlers) h({ channelIds }); }

  api: DiscordApi = {
    fetchHistory: async (channelId, limit) => [...(this.channels.get(channelId) ?? [])].slice(-limit),
    send: async (channelId, text, replyTo) => {
      if (this.failSend) throw new Error("Discord is down");
      return this.add({ channelId, guildId: "g1", authorId: this.selfId, authorName: "Bot", authorIsBot: true, content: text, replyToId: replyTo ?? null, mentions: [], isDM: channelId.startsWith("dm") }).id;
    },
    sendImage: async (channelId, bytes, name, replyTo) => {
      this.pictures.push({ channelId, name, size: bytes.length });
      return this.add({ channelId, guildId: "g1", authorId: this.selfId, authorName: "Bot", authorIsBot: true, content: `[picture ${name}]`, replyToId: replyTo ?? null, mentions: [], isDM: channelId.startsWith("dm") }).id;
    },
    dm: async (userId, text) => { if (this.failDm) throw new Error("Cannot send messages to this user"); this.dms.push({ userId, text }); },
    edit: async (channelId, id, text) => { const m = this.find(channelId, id); if (!m) throw new Error("unknown message"); m.content = text; },
    typing: async () => { this.typings++; },
    kick: async (channelId, userId) => { this.kicked.push({ channelId, userId }); },
    unkick: async (channelId, userId) => { this.kicked = this.kicked.filter((k) => !(k.channelId === channelId && k.userId === userId)); this.restored.push({ channelId, userId }); },
  };
  onMessage(cb: (m: DMessage) => void): void { this.handlers.push(cb); }
  async login(): Promise<void> { this.loggedIn = true; }
  async destroy(): Promise<void> { this.destroyed = true; }
}
