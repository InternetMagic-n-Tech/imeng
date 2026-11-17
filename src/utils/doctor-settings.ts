import fs from "node:fs";
import path from "node:path";
import {
  UPSTREAM, MODEL, JUDGE_MODEL, JUDGE_URL, JUDGE_API, JUDGE_INSTANCE, JUDGE_NUM_CTX, IMENG_PATH, SYSTEM_PROMPT, config,
  INVOCATION, DICE, PORT, REDIS_URL, DATABASE_URL, TRIGGER_RE,
} from "./config.js";
import { stateBlock, initialState, diceBlock } from "./state.js";
import type { Settings } from "./doctor.js";

/** The doctor's view of the app's configuration. Shared by `npm run doctor` and the server's --preflight. */
export function buildSettings(packageJsonPath = "package.json"): Settings {
  let engines: string | undefined;
  try { engines = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).engines?.node; } catch { /* optional */ }
  return {
    upstream: UPSTREAM,
    model: MODEL,
    judgeModel: JUDGE_MODEL,
    judgeUrl: JUDGE_URL,
    judgeApi: JUDGE_API,
    judgeInstance: JUDGE_INSTANCE,
    judgeNumCtx: JUDGE_NUM_CTX,
    gameDir: IMENG_PATH,
    systemPrompt: SYSTEM_PROMPT,
    fixedPromptText: SYSTEM_PROMPT + stateBlock(initialState()) + (DICE ? diceBlock() : ""),
    game: config,
    invocation: INVOCATION,
    dice: DICE,
    port: PORT,
    redisUrl: REDIS_URL,
    databaseUrl: DATABASE_URL,
    piiSalt: process.env.PII_SALT || "",
    nodeEngines: engines,
    promptFileFound: fs.existsSync(path.join(IMENG_PATH, "SYSTEM_PROMPT.md")),
    triggerPattern: TRIGGER_RE,
  };
}
