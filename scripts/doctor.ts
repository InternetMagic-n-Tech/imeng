import "../src/utils/env-boot.js";
import fs from "node:fs";
import { readGameFile } from "../src/utils/game-file.js";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { realSys } from "../src/utils/doctor-sys.js";
import { runDoctor, isProblem } from "../src/utils/doctor.js";
import { formatReport } from "../src/utils/doctor-format.js";

/*
 * Environment doctor. Run it with `npm run doctor`.
 *   --bail            stop at the first warning or failure and exit 1 (otherwise it reports everything and exits 0)
 *   --ignore <id>     treat a known, accepted finding as informational (repeatable), e.g. --ignore ctx-offload
 *   --probe           also send a tiny real request to the narrator and the judge (loads the models)
 *   --json            machine-readable output
 */
const argv = yargs(hideBin(process.argv))
  .scriptName("doctor")
  .option("bail", { type: "boolean", default: false, describe: "Exit 1 at the first warning or failure" })
  .option("ignore", { type: "string", array: true, default: [] as string[], describe: "Finding ids to treat as informational" })
  .option("probe", { type: "boolean", default: false, describe: "Send a 1-token request to the narrator and the judge" })
  .option("json", { type: "boolean", default: false, describe: "Print the report as JSON" })
  .strict()
  .help()
  .parseSync();

// Validate config.json ourselves first so a typo is a finding, not a crash inside config.ts.
const gameDir = path.resolve(process.env.IMENG_PATH || process.env.GAME_DIR || "./imengs/dungeon-game");
try {
  await readGameFile(gameDir);
} catch (e) {
  console.error(`✗ ${path.join(gameDir)}: ${(e as Error).message}`);
  process.exit(1);
}

const { buildSettings } = await import("../src/utils/doctor-settings.js");
const settings = buildSettings();
const report = await runDoctor(realSys(), settings, { bail: argv.bail, probe: argv.probe, ignore: argv.ignore as string[] });
const problems = report.findings.filter(isProblem);

if (argv.json) console.log(JSON.stringify({ ...report, problems: problems.length }, null, 2));
else for (const line of formatReport(report, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, gameDir: settings.gameDir })) console.log(line);

process.exit(argv.bail && problems.length ? 1 : 0);
