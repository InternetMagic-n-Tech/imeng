import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, loadBridgeConfig, readBridgeAddress, readGameOptions, bridgeConfigSchema } from "../src/modules/discord/bridge/config.js";

const GAME = path.join(process.cwd(), "tests/fixtures/sync"); // sync repair
const PLAIN = path.join(process.cwd(), "tests/fixtures/game"); // no sync, no discord key
const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz123456";
const bot = (over: object = {}) => ({ name: "desk", token: TOKEN, game: GAME, ...over });
const cfg = (over: object = {}) => ({ proxy: { url: "http://localhost:3001", apiKey: "k" }, bots: [bot()], ...over });
const tmpGame = (extra: object) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "game-")); const base = JSON.parse(fs.readFileSync(path.join(GAME, "config.json"), "utf8")); fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ ...base, ...extra })); return d; };

describe("resolveConfig", () => {
  it("fills in the defaults, gives each bot the proxy, and reads the game's own Discord settings", async () => {
    const r = await resolveConfig(cfg());
    expect(r.bridge).toEqual({ port: 3030, host: "127.0.0.1" });
    expect(r.bots[0]).toMatchObject({ name: "desk", channels: "all", dms: true, answerWhen: "mention", context: {}, proxy: { url: "http://localhost:3001", apiKey: "k" } });
    expect(r.bots[0].options).toEqual({ scope: "user", mergeContext: "mentions", historyLimit: 200, modelId: "sync-game", syncMode: "repair" });
    expect(r.bots[0].warnings).toEqual([]);
  });

  it("the game's `discord` key sets scope, merge_context and history_limit; a bot's own proxy wins", async () => {
    const g = tmpGame({ discord: { scope: "channel", merge_context: "reply", history_limit: 50 } });
    const r = await resolveConfig(cfg({ bots: [bot({ game: g, proxy: { url: "http://other:9" }, channels: ["123456", "789012"], guilds: ["55555"], dms: false, answerWhen: "all", context: { symbol: "AAPL" } })] }));
    expect(r.bots[0].options).toMatchObject({ scope: "channel", mergeContext: "reply", historyLimit: 50 });
    expect(r.bots[0]).toMatchObject({ proxy: { url: "http://other:9" }, channels: ["123456", "789012"], guilds: ["55555"], dms: false, answerWhen: "all", context: { symbol: "AAPL" } });
  });

  it("warns when the game does not repair its record (edits and deletes in Discord would only be noticed)", async () => {
    const r = await resolveConfig(cfg({ bots: [bot({ game: PLAIN })] }));
    expect(r.bots[0].warnings[0]).toContain('sync.mode is "detect"');
    expect(r.bots[0].warnings[0]).toContain("bot desk");
  });

  it("refuses what is wrong, with one readable message", async () => {
    await expect(resolveConfig(cfg({ bots: [bot({ token: "short" })] }))).rejects.toThrow("bots.0.token");
    await expect(resolveConfig(cfg({ bots: [bot({ name: "has space" })] }))).rejects.toThrow("bots.0.name");
    await expect(resolveConfig(cfg({ bots: [bot({ channels: ["not-a-number"] })] }))).rejects.toThrow("bots.0.channels");
    await expect(resolveConfig(cfg({ bots: [bot({ surprise: 1 })] }))).rejects.toThrow(/surprise|Unrecognized/);
    await expect(resolveConfig(cfg({ bots: [] }))).rejects.toThrow("bots");
    await expect(resolveConfig(cfg({ proxy: { url: "nope" } }))).rejects.toThrow("proxy.url");
    await expect(resolveConfig(cfg({ bridge: { port: 70000 } }))).rejects.toThrow("bridge.port");
    await expect(resolveConfig({ bots: [bot()] })).rejects.toThrow("proxy");
  });

  it("two bots may not share a name or a token", async () => {
    await expect(resolveConfig(cfg({ bots: [bot(), bot({ token: TOKEN + "x" })] }))).rejects.toThrow("same name");
    await expect(resolveConfig(cfg({ bots: [bot(), bot({ name: "other" })] }))).rejects.toThrow("same token");
    expect((await resolveConfig(cfg({ bots: [bot(), bot({ name: "other", token: TOKEN + "x" })] }))).bots).toHaveLength(2);
  });

  it("a game folder that is missing or has a bad config.json is named in the error", async () => {
    await expect(resolveConfig(cfg({ bots: [bot({ game: "/nope/nothing" })] }))).rejects.toThrow("config.json not found");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "game-"));
    fs.writeFileSync(path.join(d, "config.json"), "{not json");
    await expect(readGameOptions(d)).rejects.toThrow("config.json could not be read");
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ discord: { scope: "everyone" } }));
    await expect(readGameOptions(d)).rejects.toThrow("discord.scope");
  });

  it("reads a game written in config.mjs (same loader as the proxy), no generated JSON needed", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "game-"));
    fs.writeFileSync(path.join(d, "config.mjs"), "export default () => ({ model_id: 'js-game', discord: { scope: 'channel' } });\n");
    const r = await readGameOptions(d);
    expect(r.options).toMatchObject({ scope: "channel", modelId: "js-game" });
    expect(fs.existsSync(path.join(d, "config.json"))).toBe(false);
  });

  it("a relative game folder is resolved from where the bridge runs", async () => {
    expect((await resolveConfig(cfg({ bots: [bot({ game: "tests/fixtures/sync" })] }))).bots[0].gameDir).toBe(GAME);
  });

  it("the schema alone rejects an unknown top-level key", async () => { expect(bridgeConfigSchema.safeParse({ ...cfg(), extra: 1 }).success).toBe(false); });
});

describe("the config file", () => {
  it("is read from an .mjs file and checked; a missing file says what to do", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dc-")), "discord.config.mjs");
    fs.writeFileSync(f, `export default ${JSON.stringify(cfg({ bridge: { port: 4044 } }))};`);
    expect((await loadBridgeConfig(f)).bots[0].name).toBe("desk");
    expect(await readBridgeAddress(f)).toEqual({ host: "127.0.0.1", port: 4044 });
    await expect(loadBridgeConfig(path.join(os.tmpdir(), "nope.mjs"))).rejects.toThrow("copy discord.config.example.mjs");
    expect(await readBridgeAddress(path.join(os.tmpdir(), "nope.mjs"))).toEqual({ host: "127.0.0.1", port: 3030 });
  });

  it("a .json file works too", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dc-")), "d.json");
    fs.writeFileSync(f, JSON.stringify(cfg()));
    expect((await loadBridgeConfig(f)).bots).toHaveLength(1);
  });

  it("the committed example is a valid config shape (with its placeholders replaced)", async () => {
    const m = (await import("../discord.config.example.mjs" as string)).default as any;
    const filled = { ...m, bots: m.bots.map((b: any, i: number) => ({ ...b, token: TOKEN + i, game: GAME })) };
    expect((await resolveConfig(filled)).bots.length).toBe(m.bots.length);
  });
});
