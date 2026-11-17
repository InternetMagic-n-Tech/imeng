import { describe, it, expect } from "@jest/globals";
import { buildTranscript } from "../src/modules/discord/bridge/transcript.js";
import type { DMessage } from "../src/modules/discord/bridge/types.js";

const SELF = "900";
let n = 1000;
const mk = (o: Partial<DMessage> & { authorId: string; content: string }): DMessage => ({ id: String(n++), channelId: "c1", guildId: "g1", authorName: o.authorId === SELF ? "Bot" : `U${o.authorId}`, authorIsBot: o.authorId === SELF, createdAt: n, replyToId: null, mentions: [], isDM: false, ...o });
const bea = (content: string, o: Partial<DMessage> = {}) => mk({ authorId: "111", authorName: "Bea", content, mentions: [SELF], ...o });
const bo = (content: string, o: Partial<DMessage> = {}) => mk({ authorId: "222", authorName: "Bo", content, mentions: [SELF], ...o });
const bot = (content: string, to: DMessage) => mk({ authorId: SELF, content, replyToId: to.id });
const run = (history: DMessage[], pending: DMessage, o: object = {}) => buildTranscript({ history, pending, pendingText: pending.content.replace(`<@${SELF}> `, ""), selfId: SELF, scope: "user", mergeContext: "mentions", ...o });

describe("a conversation of one person (scope user)", () => {
  it("is the messages the bot answered, each with its answer, then the new message; other talk in the channel is left out", () => {
    const a1 = bea(`<@${SELF}> first`), r1 = bot("first answer", a1);
    const chatter = bo("we should go for lunch"), b1 = bo(`<@${SELF}> bo's own question`), rb = bot("bo's answer", b1);
    const unanswered = bea("talking to the room, not the bot", { mentions: [] });
    const a2 = bea(`<@${SELF}> second`), r2 = bot("second answer", a2);
    const pending = bea(`<@${SELF}> third`);
    const t = run([a1, r1, chatter, b1, rb, unanswered, a2, r2, pending], pending);
    expect(t.messages).toEqual([
      { role: "user", content: "first" }, { role: "assistant", content: "first answer" },
      { role: "user", content: "second" }, { role: "assistant", content: "second answer" },
      { role: "user", content: "third" },
    ]);
    expect(t.context).toBe("");
  });

  it("puts the pieces of a long answer back together, and orders by message id, not by the order they were fetched", () => {
    const a1 = bea(`<@${SELF}> tell me a story`);
    const p1 = bot("Once upon a time", a1), p2 = bot("there was a long road.", a1), p3 = bot("The end.", a1);
    const pending = bea(`<@${SELF}> more`);
    const t = run([pending, p3, p1, a1, p2], pending);
    expect(t.messages.map((m) => m.content)).toEqual(["tell me a story", "Once upon a time\nthere was a long road.\nThe end.", "more"]);
  });

  it("uses what a message says NOW (an edit is picked up), and a message that was deleted is simply gone", () => {
    const a1 = bea(`<@${SELF}> original`), r1 = bot("answer to it", a1);
    a1.content = `<@${SELF}> edited text`;
    const gone = bea(`<@${SELF}> deleted`), rGone = bot("orphan answer", gone);
    const pending = bea(`<@${SELF}> next`);
    expect(run([a1, r1, rGone, pending], pending).messages.map((m) => m.content)).toEqual(["edited text", "answer to it", "next"]);
  });

  it("in a direct message every message of the person is part of it, answered or not", () => {
    const d1 = bea("hello", { isDM: true, mentions: [], guildId: null }), r1 = bot("hi", d1);
    const d2 = bea("anyone there?", { isDM: true, mentions: [], guildId: null });
    const pending = bea("hello??", { isDM: true, mentions: [], guildId: null });
    expect(run([d1, r1, d2, pending], pending).messages).toEqual([
      { role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "anyone there?" }, { role: "user", content: "hello??" },
    ]);
  });

  it("a new conversation is just the message", () => {
    const pending = bea(`<@${SELF}> hi`);
    expect(run([pending], pending).messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("a shared conversation (scope channel)", () => {
  it("is every person's answered messages in time order", () => {
    const a1 = bea(`<@${SELF}> a1`), r1 = bot("ra1", a1), b1 = bo(`<@${SELF}> b1`), rb = bot("rb1", b1);
    const pending = bea(`<@${SELF}> a2`);
    expect(run([a1, r1, b1, rb, pending], pending, { scope: "channel" }).messages.map((m) => m.content)).toEqual(["a1", "ra1", "b1", "rb1", "a2"]);
  });
});

describe("background the message points at (never part of the transcript)", () => {
  it("the message being replied to", () => {
    const other = bo("I think the answer is 42", { mentions: [] });
    const pending = bea("is he right?", { mentions: [SELF], replyToId: other.id });
    const t = run([other, pending], pending);
    expect(t.context).toBe('The message being replied to, from Bo: "I think the answer is 42"');
    expect(t.messages).toEqual([{ role: "user", content: "is he right?" }]);
  });

  it("someone it mentions: the latest exchanges the bot had with them", () => {
    const b1 = bo(`<@${SELF}> what is the capital of France?`), rb1 = bot("Paris.", b1);
    const b2 = bo(`<@${SELF}> and of Spain?`), rb2 = bot("Madrid.", b2);
    const b3 = bo(`<@${SELF}> and of Italy?`), rb3 = bot("Rome.", b3);
    const pending = bea(`<@${SELF}> you told <@222> something about capitals, what was it?`, { mentions: [SELF, "222"] });
    const t = run([b1, rb1, b2, rb2, b3, rb3, pending], pending);
    expect(t.context).toContain("Earlier in this channel you spoke with Bo");
    expect(t.context).toContain('Bo said "and of Spain?" and you replied "Madrid."');
    expect(t.context).toContain('Bo said "and of Italy?" and you replied "Rome."');
    expect(t.context).not.toContain("France"); // only the latest two
    expect(t.messages.map((m) => m.content)).toEqual(["you told <@222> something about capitals, what was it?"]);
  });

  it("a mention of someone the bot never spoke to adds nothing; mergeContext reply ignores mentions; off ignores everything; the text is capped", () => {
    const b1 = bo(`<@${SELF}> hi`), rb1 = bot("hello", b1);
    const target = bo("quoted", { mentions: [] });
    const p = bea(`<@${SELF}> and <@333>?`, { mentions: [SELF, "333"], replyToId: target.id });
    expect(run([b1, rb1, target, p], p).context).toBe('The message being replied to, from Bo: "quoted"');
    const p2 = bea(`<@${SELF}> and <@222>?`, { mentions: [SELF, "222"], replyToId: target.id });
    expect(run([b1, rb1, target, p2], p2, { mergeContext: "reply" }).context).toBe('The message being replied to, from Bo: "quoted"');
    expect(run([b1, rb1, target, p2], p2, { mergeContext: "off" }).context).toBe("");
    const long = bo("x".repeat(5000), { mentions: [] });
    const p3 = bea(`<@${SELF}> ?`, { replyToId: long.id });
    expect(run([long, p3], p3).context.length).toBeLessThan(400); // each quote is cut
  });

  it("replying to one of its own earlier answers says so", () => {
    const a1 = bea(`<@${SELF}> hi`), r1 = bot("a long answer", a1);
    const pending = bea("explain that", { mentions: [], replyToId: r1.id, replyToAuthorId: SELF });
    expect(run([a1, r1, pending], pending).context).toBe('The message being replied to is one of your own earlier replies: "a long answer"');
  });
});
