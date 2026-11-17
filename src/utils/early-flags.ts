import yargs from "yargs";
import { hideBin } from "yargs/helpers";

/* Flags that settings read while the config loads (before the full parser in cli.ts runs). A flag always wins over its environment variable. */

const argv = (): string[] => (process.env.NODE_ENV === "test" ? [] : hideBin(process.argv));
const parse = (args: string[]) => yargs(args)
  .option("system-prompt", { type: "string" })
  .option("experiment-per-chat", { type: "boolean" })
  .option("telemetry", { type: "boolean" })
  .help(false).version(false).exitProcess(false).fail(false).parserConfiguration({ "unknown-options-as-args": true }).parseSync();

/** Where the system prompt is read from: `--system-prompt <file>`, else SYSTEM_PROMPT_PATH; empty means the game folder's SYSTEM_PROMPT.md. */
export function systemPromptPath(args: string[] = argv(), env: NodeJS.ProcessEnv = process.env): string {
  return String(parse(args).systemPrompt || env.SYSTEM_PROMPT_PATH || "").trim();
}

/** `--experiment-per-chat` / `--no-experiment-per-chat`, else MLFLOW_EXPERIMENT_PER_CHAT: each chat session is its own MLflow experiment. Off by default. */
export function experimentPerChat(args: string[] = argv(), env: NodeJS.ProcessEnv = process.env): boolean {
  const f = parse(args).experimentPerChat;
  return typeof f === "boolean" ? f : ["1", "true", "on"].includes((env.MLFLOW_EXPERIMENT_PER_CHAT ?? "").toLowerCase());
}

/** `--no-telemetry` / `--telemetry`, else TELEMETRY=off: no MLflow tracing at all, whatever a game or its owner says. On by default; the flag wins. */
export function telemetryEnabled(args: string[] = argv(), env: NodeJS.ProcessEnv = process.env): boolean {
  const f = parse(args).telemetry;
  return typeof f === "boolean" ? f : !["0", "off", "false", "no"].includes((env.TELEMETRY ?? "").toLowerCase());
}
