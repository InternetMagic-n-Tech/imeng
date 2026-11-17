import type { DiscordApi } from "./types.js";

/** Putting an answer into Discord: splitting it at the 2000-character limit, and editing one message in place while it is still being written. */

export const DISCORD_MAX = 1900; // a message is 2000 at most; the rest is room for closing and reopening a code fence

/**
 * Split text into messages of at most `max` characters, at a paragraph, line or word where possible. A code block that is cut is closed at the end of
 * one message and reopened at the start of the next. Prefix-stable: as text grows, the chunks already finished do not change, which is what lets the
 * last message be edited while the earlier ones stay.
 */
export function splitForDiscord(text: string, max = DISCORD_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  let fence: string | null = null; // the language of a code block that is open across a cut
  const finish = (body: string): string => {
    let chunk = fence !== null ? "```" + fence + "\n" + body : body;
    const marks = [...chunk.matchAll(/```([^\n`]*)/g)];
    if (marks.length % 2 === 1) { fence = marks.at(-1)![1].trim(); chunk += "\n```"; } else fence = null;
    return chunk;
  };
  while (rest.length > max) {
    const from = Math.max(0, max - 300);
    const win = rest.slice(from, max);
    const para = win.lastIndexOf("\n\n"), line = win.lastIndexOf("\n"), word = win.lastIndexOf(" ");
    const rel = para >= 0 ? para + 2 : line >= 0 ? line + 1 : word >= 0 ? word + 1 : -1;
    const cut = rel >= 0 ? from + rel : max;
    out.push(finish(rest.slice(0, cut).trimEnd()));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length || !out.length) out.push(finish(rest));
  return out;
}

export interface Clock { now(): number }

export interface ReplyOptions { max?: number; minEditMs?: number; clock?: Clock }

/**
 * One answer being written into a channel. `push` adds text as it arrives; the last message is edited at most once every `minEditMs` (Discord limits
 * edits), a new message starts when the text outgrows one, and `finish` writes everything exactly. Every message replies to the player's message,
 * so the bridge can find all the pieces of an answer again.
 */
export class DiscordReply {
  private text = "";
  private sent: { id: string; text: string }[] = [];
  private lastFlush = -Infinity;
  edits = 0;
  messages = 0;
  private readonly max: number; private readonly minEditMs: number; private readonly clock: Clock;
  constructor(private api: DiscordApi, private channelId: string, private replyTo: string, opts: ReplyOptions = {}) {
    this.max = opts.max ?? DISCORD_MAX; this.minEditMs = opts.minEditMs ?? 1200; this.clock = opts.clock ?? { now: () => Date.now() };
  }

  get started(): boolean { return this.sent.length > 0; }
  get full(): string { return this.text; }

  private async flush(): Promise<void> {
    this.lastFlush = this.clock.now();
    const chunks = splitForDiscord(this.text, this.max);
    for (let i = 0; i < chunks.length; i++) {
      const have = this.sent[i];
      if (!chunks[i].trim()) continue;
      if (!have) { const id = await this.api.send(this.channelId, chunks[i], this.replyTo); this.sent.push({ id, text: chunks[i] }); this.messages++; }
      else if (have.text !== chunks[i]) { await this.api.edit(this.channelId, have.id, chunks[i]); have.text = chunks[i]; this.edits++; }
    }
  }

  async push(delta: string): Promise<void> {
    if (!delta) return;
    this.text += delta;
    if (!this.started || this.clock.now() - this.lastFlush >= this.minEditMs) await this.flush();
  }

  /** Replace what was written so far (a picture's markdown is taken out once the whole answer is known). */
  async rewrite(text: string): Promise<void> {
    this.text = text;
    await this.flush();
  }

  /** Write the answer out in full. Returns the whole text (what the proxy said). */
  async finish(): Promise<string> {
    if (!this.text.trim()) { this.text = this.text || ""; if (!this.started) { const id = await this.api.send(this.channelId, "(the game had nothing to say)", this.replyTo); this.sent.push({ id, text: "(the game had nothing to say)" }); this.messages++; } return this.text; }
    await this.flush();
    return this.text;
  }
}
