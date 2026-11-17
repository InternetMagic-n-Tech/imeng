import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { gameConfigSchema } from "../../../utils/config-schema.js";
import { readGameFile } from "../../../utils/game-file.js";

/**
 * The bridge's configuration: a file you keep out of git (discord.config.mjs; start from discord.config.example.mjs), not environment variables, because
 * one process runs many bots, each with its own token and secrets. Each bot says which game it serves; the game's own config.json supplies how Discord
 * treats it (the `discord` key: scope, merge_context, history_limit).
 */

const snowflake = z.string().regex(/^\d{5,25}$/, "a Discord id (digits only)");

export const botSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/i, "letters, digits, - and _ (it becomes part of every conversation's id)"),
  token: z.string().min(20, "the bot token from the Discord developer portal"),
  /** The game this bot serves: its folder (where config.json is), relative to where the bridge runs. */
  game: z.string().min(1),
  /** Overrides the top-level proxy for this bot. */
  proxy: z.object({ url: z.string().url(), apiKey: z.string().optional() }).strict().optional(),
  /** The model name sent to the proxy (default: the game's model_id). */
  model: z.string().optional(),
  /** Only these servers (guilds). Missing: any server the bot is in. */
  guilds: z.array(snowflake).optional(),
  /** Channels it may answer in: "all", or a list of channel ids (a thread counts as its parent channel). */
  channels: z.union([z.literal("all"), z.array(snowflake)]).default("all"),
  /** Answer direct messages. */
  dms: z.boolean().default(true),
  /** mention (default): only when @mentioned or replied to. all: every message in the allowed channels. */
  answerWhen: z.enum(["mention", "all"]).default("mention"),
  /** Free-form settings for this bot (for example { symbol: "AAPL" }); the game is told them every turn. */
  context: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const bridgeConfigSchema = z.object({
  bridge: z.object({ port: z.number().int().min(1).max(65535).default(3030), host: z.string().default("127.0.0.1") }).strict().default({ port: 3030, host: "127.0.0.1" }),
  /** The proxy every bot talks to (an OpenAI-compatible endpoint). */
  proxy: z.object({ url: z.string().url(), apiKey: z.string().optional() }).strict(),
  bots: z.array(botSchema).min(1),
}).strict().superRefine((c, ctx) => {
  const seen = (what: "name" | "token") => {
    const set = new Set<string>();
    c.bots.forEach((b, i) => { const v = b[what].toLowerCase(); if (set.has(v)) ctx.addIssue({ code: "custom", path: ["bots", i, what], message: `two bots have the same ${what}` }); set.add(v); });
  };
  seen("name"); seen("token");
});

export type BotConfig = z.infer<typeof botSchema>;
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

export interface GameOptions {
  scope: "user" | "channel";
  mergeContext: "mentions" | "reply" | "off";
  historyLimit: number;
  modelId: string;
  /** The game's sync mode: Discord edits and deletes only get repaired in "repair". */
  syncMode: "off" | "detect" | "repair";
}

export interface ResolvedBot extends BotConfig {
  proxy: { url: string; apiKey?: string };
  gameDir: string;
  game: string;
  options: GameOptions;
  /** Things worth telling the operator at start. */
  warnings: string[];
}

export interface ResolvedConfig { bridge: BridgeConfig["bridge"]; bots: ResolvedBot[] }

/** The game's own settings for Discord, from its config.mjs, config.ts or config.json (the same loader as the proxy) (validated with the same schema the proxy uses). */
export async function readGameOptions(gameDir: string): Promise<{ options: GameOptions; warnings: string[] }> {
  const { raw, file: found } = await readGameFile(gameDir);
  const file = found ?? path.join(gameDir, "config.json");
  if (!found) throw new Error(`${file} not found (is the bot's "game" folder right? it needs config.mjs, config.ts or config.json)`);
  const r = gameConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`${file}: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  const g: any = r.data;
  const warnings: string[] = [];
  const syncMode = g.sync?.mode ?? "detect";
  if (syncMode !== "repair") warnings.push(`${gameDir}: sync.mode is "${syncMode}", so a message edited or deleted in Discord is noticed but not repaired in the record (set "sync": {"mode": "repair"} in its config.json)`);
  return {
    options: { scope: g.discord?.scope ?? "user", mergeContext: g.discord?.merge_context ?? "mentions", historyLimit: g.discord?.history_limit ?? 200, modelId: String(g.model_id ?? "text-game"), syncMode },
    warnings,
  };
}

export function bridgeConfigPath(): string { return path.resolve(process.env.DISCORD_CONFIG || "discord.config.mjs"); }

/** Check a loaded config object and resolve each bot's game folder and options. Throws one readable error. */
export async function resolveConfig(raw: unknown, cwd = process.cwd()): Promise<ResolvedConfig> {
  const r = bridgeConfigSchema.safeParse(raw);
  if (!r.success) throw new Error("discord config: " + r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; "));
  const bots = await Promise.all(r.data.bots.map(async (b): Promise<ResolvedBot> => {
    const gameDir = path.resolve(cwd, b.game);
    const { options, warnings } = await readGameOptions(gameDir);
    return { ...b, proxy: b.proxy ?? r.data.proxy, gameDir, options, warnings: warnings.map((w) => `bot ${b.name}: ${w}`) };
  }));
  return { bridge: r.data.bridge, bots };
}

/** Read discord.config.mjs (or DISCORD_CONFIG, a .js or .json path) and resolve it. */
export async function loadBridgeConfig(file = bridgeConfigPath(), cwd = process.cwd()): Promise<ResolvedConfig> {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: copy discord.config.example.mjs to discord.config.mjs and fill it in`);
  const raw = file.endsWith(".json") ? JSON.parse(fs.readFileSync(file, "utf8")) : (await import(/* @vite-ignore */ pathToFileURL(file).href)).default;
  return await resolveConfig(raw, cwd);
}

/** The bridge's port and host from the config file, without validating the rest (the proxy only needs to know where to look). */
export async function readBridgeAddress(file = bridgeConfigPath()): Promise<{ host: string; port: number }> {
  try {
    if (!fs.existsSync(file)) return { host: "127.0.0.1", port: 3030 };
    const raw: any = file.endsWith(".json") ? JSON.parse(fs.readFileSync(file, "utf8")) : (await import(/* @vite-ignore */ pathToFileURL(file).href)).default;
    return { host: String(raw?.bridge?.host ?? "127.0.0.1"), port: Number(raw?.bridge?.port) || 3030 };
  } catch { return { host: "127.0.0.1", port: 3030 }; }
}
