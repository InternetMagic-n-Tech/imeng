import { describe, it, expect } from "@jest/globals";
import { decide, chatKeyFor, stripMention, spoilerPrivate } from "../src/modules/discord/bridge/route.js";
import type { DMessage } from "../src/modules/discord/bridge/types.js";

const SELF = "900";
const msg = (o: Partial<DMessage> = {}): DMessage => ({ id: "1", channelId: "c1", guildId: "g1", authorId: "111", authorName: "Bea", authorIsBot: false, content: `<@${SELF}> hello`, createdAt: 0, replyToId: null, mentions: [SELF], isDM: false, ...o });
const bot = (o: object = {}) => ({ name: "desk", channels: "all" as const, dms: true, answerWhen: "mention" as const, ...o });

describe("stripMention", () => {
  it("removes the bot's own mention (both forms) and tidies the spaces, leaving other mentions", () => {
    expect(stripMention(`<@${SELF}> what about <@222>?`, SELF)).toBe("what about <@222>?");
    expect(stripMention(`hey <@!${SELF}>   there`, SELF)).toBe("hey there");
    expect(stripMention(`<@${SELF}>`, SELF)).toBe("");
  });
});

describe("chatKeyFor", () => {
  it("one conversation per person by default, one per channel for a table, one per person for a DM", () => {
    expect(chatKeyFor("desk", "user", msg())).toBe("discord:desk:c1:111");
    expect(chatKeyFor("desk", "channel", msg())).toBe("discord:desk:c1");
    expect(chatKeyFor("desk", "channel", msg({ isDM: true, channelId: "dm9" }))).toBe("discord:desk:dm:111");
    expect(chatKeyFor("desk", "user", msg({ isDM: true }))).toBe("discord:desk:dm:111");
  });
});

describe("decide", () => {
  it("answers a mention and a reply to the bot, with the mention removed from the text", () => {
    expect(decide(bot(), "user", msg(), SELF)).toEqual({ answer: true, chatKey: "discord:desk:c1:111", text: "hello" });
    const reply = msg({ content: "and then?", mentions: [], replyToId: "5", replyToAuthorId: SELF });
    expect(decide(bot(), "user", reply, SELF)).toMatchObject({ answer: true, text: "and then?" });
  });

  it("ignores talk that is not for it: no mention, a reply to someone else, nothing but a mention", () => {
    expect(decide(bot(), "user", msg({ content: "just chatting", mentions: [] }), SELF)).toMatchObject({ answer: false, reason: expect.stringContaining("not addressed") });
    expect(decide(bot(), "user", msg({ content: "yes", mentions: [], replyToId: "5", replyToAuthorId: "222" }), SELF).answer).toBe(false);
    expect(decide(bot(), "user", msg({ content: `<@${SELF}>` }), SELF)).toMatchObject({ answer: false, reason: "nothing but a mention" });
  });

  it("answers every message in its channels when answerWhen is all", () => {
    expect(decide(bot({ answerWhen: "all" }), "user", msg({ content: "no mention", mentions: [] }), SELF).answer).toBe(true);
  });

  it("never answers a bot (itself or another) or an empty message", () => {
    expect(decide(bot(), "user", msg({ authorIsBot: true }), SELF)).toMatchObject({ answer: false });
    expect(decide(bot(), "user", msg({ authorId: SELF }), SELF)).toMatchObject({ answer: false });
    expect(decide(bot({ answerWhen: "all" }), "user", msg({ content: "  ", mentions: [] }), SELF).answer).toBe(false);
  });

  it("keeps to its servers and channels; a thread counts as its parent channel", () => {
    expect(decide(bot({ guilds: ["g2"] }), "user", msg(), SELF)).toMatchObject({ answer: false, reason: expect.stringContaining("server") });
    expect(decide(bot({ guilds: ["g1"] }), "user", msg(), SELF).answer).toBe(true);
    expect(decide(bot({ channels: ["c9"] }), "user", msg(), SELF)).toMatchObject({ answer: false, reason: expect.stringContaining("channel") });
    expect(decide(bot({ channels: ["c1"] }), "user", msg(), SELF).answer).toBe(true);
    expect(decide(bot({ channels: ["c1"] }), "user", msg({ channelId: "thread7", parentChannelId: "c1" }), SELF).answer).toBe(true);
  });

  it("direct messages need no mention and no allowed channel, and can be turned off", () => {
    const dm = msg({ isDM: true, guildId: null, channelId: "dm9", content: "hi there", mentions: [] });
    expect(decide(bot({ channels: ["c9"], guilds: ["g2"] }), "user", dm, SELF)).toEqual({ answer: true, chatKey: "discord:desk:dm:111", text: "hi there" });
    expect(decide(bot({ dms: false }), "user", dm, SELF)).toMatchObject({ answer: false, reason: expect.stringContaining("direct messages are off") });
  });
});

describe("a spoiler that holds only code is private", () => {
  it("turns ||`text`|| and a spoilered code block into <private>", () => {
    expect(spoilerPrivate("I act ||`my tattoo hurts`||")).toBe("I act <private>my tattoo hurts</private>");
    expect(spoilerPrivate("go ||```\nline one\nline two\n```|| now")).toBe("go <private>line one\nline two</private> now");
    expect(spoilerPrivate("||```js\nx\n```||")).toBe("<private>x</private>");
  });
  it("leaves any other spoiler, and plain code, alone", () => {
    for (const t of ["||a spoilered gif||", "`just code`", "||text with `code` inside||", "```\nplain block\n```"]) expect(spoilerPrivate(t)).toBe(t);
  });
  it("is applied to the message the bot answers", () => {
    const d = decide(bot(), "user", msg({ content: `<@${SELF}> go ||\`secret\`||` }), SELF);
    expect(d).toMatchObject({ answer: true, text: "go <private>secret</private>" });
  });
});

describe("pictures attached to a message", () => {
  const att = (o: any = {}) => ({ url: "https://cdn.discordapp.com/attachments/1/2/a.png", contentType: "image/png", size: 1000, ...o });
  it("takes images from Discord's own hosts within the size cap, at most three, and nothing else", async () => {
    const { pictures, decide: d } = await import("../src/modules/discord/bridge/route.js");
    expect(pictures(msg({ attachments: [att()] }))).toHaveLength(1);
    expect(pictures(msg({ attachments: [att({ url: "https://evil.example/a.png" })] }))).toHaveLength(0);
    expect(pictures(msg({ attachments: [att({ url: "http://cdn.discordapp.com/a.png" })] }))).toHaveLength(0);
    expect(pictures(msg({ attachments: [att({ contentType: "application/pdf" })] }))).toHaveLength(0);
    expect(pictures(msg({ attachments: [att({ size: 9 * 1024 * 1024 })] }))).toHaveLength(0);
    expect(pictures(msg({ attachments: [att(), att(), att(), att()] }))).toHaveLength(3);
    // a message that is only a mention but carries a picture is still for the bot
    const bot: any = { name: "b", dms: true, guilds: [], channels: "all", answerWhen: "mention" };
    expect(d(bot, "user", msg({ content: `<@${SELF}>`, attachments: [att()] }), SELF)).toMatchObject({ answer: true, text: "(sent a picture)" });
  });
});
