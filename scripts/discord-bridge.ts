import "../src/utils/env-boot.js";
import { loadBridgeConfig } from "../src/modules/discord/bridge/config.js";
import { runBridge } from "../src/modules/discord/bridge/main.js";
import { makeDiscordJsClient } from "../src/modules/discord/bridge/discordjs.js";

/** The Discord bridge process: `npm run discord` (or started for you outside production by INTERFACES=...,discord). See docs/DISCORD.md. */
try {
  const config = await loadBridgeConfig();
  const bridge = await runBridge(config, { makeClient: makeDiscordJsClient });
  const a = bridge.address();
  console.log(`[bridge] ready: ${bridge.ready().length} bot(s), health on http://${a?.host}:${a?.port}/healthz`);
  const stop = async (): Promise<void> => { console.log("[bridge] stopping"); await bridge.stop(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
} catch (e) {
  console.error(`[bridge] could not start: ${(e as Error).message}`);
  process.exit(1);
}
