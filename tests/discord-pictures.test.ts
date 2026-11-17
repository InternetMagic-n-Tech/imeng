import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import http from "node:http";
import { FakeDiscord } from "./fake-discord.js";
import { sseResponse, sseChunks } from "./helpers.js";
import { PNG } from "./fake-renderer.js";

const { extractPictures } = await import("../src/modules/discord/bridge/pictures.js");
const { runBridge } = await import("../src/modules/discord/bridge/main.js");
const { resolveConfig } = await import("../src/modules/discord/bridge/config.js");

const NAME = "0123456789abcdef01234567.png";
const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz123456";
const md = `![the door](https://game.example/images/${NAME})\n\nthe door`;

describe("pictures in Discord replies", () => {
  it("takes the picture markdown out of the text and names the files", async () => {
    expect(extractPictures(md)).toEqual({ text: "the door", files: [NAME] });
    expect(extractPictures("no picture here")).toEqual({ text: "no picture here", files: [] });
    expect(extractPictures("![x](https://a/b/not-ours.png) stays").files).toEqual([]);
  });
});

describe("the bridge attaches a picture the game made", () => {
  let bridge: Awaited<ReturnType<typeof runBridge>>, discord: FakeDiscord;
  const logs: string[] = [];
  const start = async (imageStatus = 200) => {
    const cfg = await resolveConfig({ proxy: { url: "http://proxy.test/v1" }, bots: [{ name: "bot1", token: TOKEN, game: "tests/fixtures/images", dms: true }] });
    cfg.bridge.port = 0;
    discord = new FakeDiscord("900");
    const fetchFn = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.endsWith("/chat/completions")) return sseResponse(sseChunks(md, false));
      if (url === `http://proxy.test/images/${NAME}`) return imageStatus === 200 ? new Response(new Uint8Array(PNG)) : new Response("", { status: imageStatus });
      throw new Error("unexpected " + url);
    }) as typeof fetch;
    bridge = await runBridge(cfg, { makeClient: () => discord, fetchFn, log: (l) => logs.push(l), typingEveryMs: 1000, minEditMs: 0 });
  };
  const until = async (fn: () => boolean) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > 3000) throw new Error("timed out: " + logs.join(" | ")); await new Promise((r) => setTimeout(r, 10)); } };
  beforeEach(() => { logs.length = 0; jest.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(async () => { await bridge.stop(); jest.restoreAllMocks(); });

  it("sends the caption as text and the picture as an attachment", async () => {
    await start();
    discord.say("dm1", "111", "Bea", "/draw the door", { isDM: true, guildId: null });
    await until(() => discord.pictures.length === 1);
    expect(discord.botMessages("dm1")[0].content).toBe("the door");
    expect(discord.pictures[0]).toEqual({ channelId: "dm1", name: NAME, size: PNG.length });
  });
  it("says so in the log when the picture cannot be fetched, and still answers", async () => {
    await start(500);
    discord.say("dm1", "111", "Bea", "/draw the door", { isDM: true, guildId: null });
    await until(() => logs.some((l) => l.includes("could not attach picture")));
    expect(discord.botMessages("dm1")[0].content).toBe("the door");
    expect(discord.pictures).toHaveLength(0);
  });
});
