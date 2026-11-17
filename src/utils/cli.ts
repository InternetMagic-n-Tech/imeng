import yargs from "yargs";
import { hideBin } from "yargs/helpers";

/** Parse command-line flags. `--no-persist` comes for free from yargs' boolean negation. */
export function parseArgs(args: string[]) {
  return yargs(args)
    .scriptName("server")
    .option("persist", {
      type: "boolean",
      default: true,
      describe:
        "Keep sessions. With --no-persist nothing is saved to disk, and on shutdown every Redis log " +
        "entry written by this process (all sessions it created) is deleted.",
    })
    .option("preflight", {
      type: "boolean",
      default: ["1", "true", "on"].includes((process.env.PREFLIGHT || "").toLowerCase()),
      describe: "Run the doctor's checks before starting and refuse to start if any check fails (warnings are shown, not fatal). Also enabled by PREFLIGHT=1.",
    })
    .option("preflight-ignore", {
      type: "string",
      array: true,
      default: [] as string[],
      describe: "Doctor finding ids to ignore during --preflight (repeatable)",
    })
    .option("system-prompt", { type: "string", describe: "Read the system prompt from this file instead of the game folder's SYSTEM_PROMPT.md. Also SYSTEM_PROMPT_PATH. The flag wins." })
    .option("experiment-per-chat", { type: "boolean", describe: "MLflow: make each chat session its own experiment (created when missing). Also MLFLOW_EXPERIMENT_PER_CHAT. The flag wins." })
    .option("telemetry", { type: "boolean", describe: "With --no-telemetry nothing is sent to MLflow, whatever a game or its owner says. Also TELEMETRY=off. The flag wins." })
    .strict()
    .help()
    .parseSync();
}

// Under Jest process.argv holds Jest's own flags, so don't parse them.
const parsed = parseArgs(process.env.NODE_ENV === "test" ? [] : hideBin(process.argv));
export const PERSIST: boolean = parsed.persist;
export const PREFLIGHT: boolean = parsed.preflight;
export const PREFLIGHT_IGNORE: string[] = parsed.preflightIgnore as string[];
