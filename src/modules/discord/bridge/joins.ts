import fs from "node:fs";
import path from "node:path";

/**
 * Where the bot joined each channel. The bot never reads anything older than that (the history it is given when it is added, or later given access to, is not its to read),
 * and when it leaves, the record goes, so joining again starts a new one. Kept in a small JSON file so a restart does not forget.
 * Two classes of chat: a group (server channel, thread, group chat) is evicted when the bot leaves; a direct chat (a DM with one person) has nothing to leave.
 */
export type ChatClass = "group" | "direct";
export const chatClass = (isDM: boolean): ChatClass => (isDM ? "direct" : "group");

export class Joins {
  private at: Record<string, number> = {};
  /** People hidden from a channel until a time: "channelId:userId" -> ms. Kept so a restart still gives the channel back. */
  private kicks: Record<string, number> = {};
  /** Channels the bot was (re)added to whose first message has not been seen yet: that message must be the launch word, or the bot stays dormant there. */
  private fresh = new Set<string>();
  private dormant = new Set<string>();
  constructor(private file: string | null) {
    if (file) { try { const d = JSON.parse(fs.readFileSync(file, "utf8")); if (d && typeof d === "object" && d.__kicks) { this.kicks = d.__kicks; delete d.__kicks; } this.at = d; } catch { /* first run */ } }
  }
  private save(): void {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + ".part", JSON.stringify({ ...this.at, __kicks: this.kicks })); fs.renameSync(this.file + ".part", this.file); } catch { /* best effort */ }
  }
  /** When the bot joined this channel; the first sight of a channel counts as joining it (at the time of its first message, so that message is its own to read). */
  joinedAt(channelId: string, firstMessageAt: number): number {
    if (this.at[channelId] === undefined) { this.at[channelId] = Math.min(Date.now(), firstMessageAt); this.save(); }
    return this.at[channelId]!;
  }
  /** The bot was added (or re-added) to a channel: joined now, whatever it held before. */
  joined(channelId: string, now = Date.now()): void { this.at[channelId] = now; this.fresh.add(channelId); this.dormant.delete(channelId); this.save(); }
  /** Called with every message in a channel and whether it is the launch word. False means the bot must stay silent: after a (re)join, the first message it sees decides, and "ok" is not the launch word. */
  mayAnswer(channelId: string, isLaunch: boolean): boolean {
    if (this.fresh.delete(channelId) && !isLaunch) this.dormant.add(channelId);
    return isLaunch && !this.dormant.has(channelId);
  }
  left(channelId: string): void { delete this.at[channelId]; this.fresh.delete(channelId); this.dormant.delete(channelId); this.save(); }
  kick(channelId: string, userId: string, until: number): void { this.kicks[`${channelId}:${userId}`] = until; this.save(); }
  /** Kicks whose time is up (removed from the list). */
  due(now = Date.now()): { channelId: string; userId: string }[] {
    const out = Object.entries(this.kicks).filter(([, u]) => u <= now).map(([k]) => { const [channelId, userId] = k.split(":"); return { channelId: channelId!, userId: userId! }; });
    for (const d of out) delete this.kicks[`${d.channelId}:${d.userId}`];
    if (out.length) this.save();
    return out;
  }
  kicksList(): { channelId: string; userId: string; until: number }[] { return Object.entries(this.kicks).map(([k, until]) => { const [channelId, userId] = k.split(":"); return { channelId: channelId!, userId: userId!, until }; }); }
  has(channelId: string): boolean { return this.at[channelId] !== undefined; }
}
