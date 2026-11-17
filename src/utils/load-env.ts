import dotenv from "dotenv";
import dotenvExpand from "dotenv-expand";

/** Loads ./.env into process.env with ${VAR} / $VAR expansion. Shell variables win. Skipped when Node got an --env-file flag (that file is then the choice, e.g. /dev/null). */
export function loadEnv(execArgv: string[] = process.execArgv, file = ".env"): void {
  if (execArgv.some((a) => a.startsWith("--env-file"))) return;
  dotenvExpand.expand(dotenv.config({ path: file, quiet: true }));
}
