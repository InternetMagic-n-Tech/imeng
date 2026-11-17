import "../src/utils/env-boot.js";
import path from "node:path";
import fs from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { profileFor } from "../src/utils/run-profile.js";
import { parseList, pickCompare } from "../src/utils/compare-models.js";
import { parseCase } from "../src/utils/case-file.js";
import { gameFileOf, gameFolders } from "../src/utils/game-file.js";
import { buildGame } from "../src/utils/md-build.js";
import { casesOf, childSpawner, runCases, recordRun, checkGameDocs, gamesIn, RESULT_MARK, transcript } from "../src/utils/driver-core.js";
import { experimentName } from "../src/utils/mlflow-admin.js";
import { zipSinceLast } from "../src/utils/zip-diff.js";

/*
 * npm run driver -- <command>. Flags beat environment variables, which beat the defaults.
 *   run <cases|games...>   run test cases (a game folder runs its cases/*.md), one process per case and model
 *   how-to-test [game]     the same for one game; with no cases it prints the game's HOW_TO_TEST.md
 *   build [games...]       build prompt templates and move inline images out of the markdown
 *   check [games...]       every game folder must have VISION.md and HOW_TO_TEST.md
 *   zip                    a zip of the files that changed since the last zip
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const env = process.env;

const common = (y: yargs.Argv) => y
  .option("game", { type: "string", describe: "Game folder (overrides the case header)" })
  .option("state", { type: "string", describe: "State to merge onto the starting state: a file or a JSON/YAML string" })
  .option("history", { type: "string", describe: "Earlier chat messages: a file or a JSON/YAML string" })
  .option("private", { type: "string", describe: "Private notes sent before the steps: a file or a JSON/YAML list" })
  .option("model", { type: "string", describe: "Narrator model (OLLAMA_MODEL)" })
  .option("compare", { type: "string", describe: "Compare models, JSON array or comma list (COMPARE_MODELS)" })
  .option("compare-prefer", { type: "number", describe: "Run only compare model N, 1-based (COMPARE_PREFER)" })
  .option("judge-model", { type: "string", default: env.DRIVER_JUDGE_MODEL, describe: "Alternative judge model for `judge:` expectations (DRIVER_JUDGE_MODEL)" })
  .option("experiment", { type: "string", default: env.MLFLOW_EXPERIMENT_NAME, describe: "MLflow experiment name, created when missing (MLFLOW_EXPERIMENT_NAME)" })
  .option("experiment-per-chat", { type: "boolean", default: ["1", "true", "on"].includes((env.MLFLOW_EXPERIMENT_PER_CHAT ?? "").toLowerCase()), describe: "One MLflow experiment per case chat (MLFLOW_EXPERIMENT_PER_CHAT)" })
  .option("mlflow-url", { type: "string", default: env.MLFLOW_TRACKING_URI, describe: "MLflow server; without it nothing is recorded (MLFLOW_TRACKING_URI)" })
  .option("concurrency", { type: "number", describe: "Cases at once (DRIVER_CONCURRENCY; 1 unless NODE_ENV=production)" })
  .option("retries", { type: "number", describe: "Retries with exponential backoff (DRIVER_RETRIES)" });

type Args = Awaited<ReturnType<ReturnType<typeof common>["parseAsync"]>>;

const abs = (v: unknown): string | undefined => (typeof v === "string" && v ? (fs.existsSync(path.resolve(v)) ? path.resolve(v) : v) : undefined); // children run elsewhere: pass files by absolute path
function filesFor(paths: string[]): string[] {
  return paths.flatMap((p) => (fs.existsSync(p) && fs.statSync(p).isDirectory() ? casesOf(p) : [p])).map((f) => path.resolve(f));
}

async function run(paths: string[], a: Args): Promise<number> {
  const files = filesFor(paths);
  if (!files.length) { console.log("No cases found."); return 0; }
  const main = (a.model as string | undefined) || env.OLLAMA_MODEL || "";
  const pick = pickCompare({ list: parseList(a.compare as string | undefined), prefer: a.comparePrefer as number | undefined });
  if (pick.note) console.warn(pick.note);
  const models = [...new Set([main, ...pick.models].filter(Boolean))];
  const profile = profileFor(env, { ...(a.concurrency ? { concurrency: Number(a.concurrency) } : {}), ...(a.retries !== undefined ? { retries: Number(a.retries) } : {}) });
  console.log(`[driver] ${files.length} case(s), models: ${models.join(", ") || "default"}, profile ${profile.name} (concurrency ${profile.concurrency})`);
  const t0 = Date.now();
  const runs = await runCases({ files, models, judgeModel: a.judgeModel as string | undefined, game: abs(a.game), over: { state: abs(a.state), history: abs(a.history), private: abs(a.private) }, profile, spawn: childSpawner(ROOT), log: (l) => console.log(l) });
  for (const r of runs) {
    console.log(r.result ? transcript(r.result) : `# ${path.basename(r.file)} (${r.model})\nERROR ${r.error}`);
    console.log(`=> ${r.result?.passed ? "PASS" : "FAIL"}\n`);
  }
  const url = a.mlflowUrl as string | undefined;
  if (url) {
    for (const r of runs) {
      try {
        const c = parseCase(r.file, { game: abs(a.game) });
        const exp = (a.experimentPerChat ? experimentName({ model: r.model || "default", session: c.chat }) : (a.experiment as string | undefined)) || experimentName({ model: r.model || "default", session: "driver" });
        const promptFile = path.join(c.game, "SYSTEM_PROMPT.md");
        await recordRun(r, { admin: { uri: url, token: env.MLFLOW_TRACKING_TOKEN }, experiment: exp, promptName: `${path.basename(c.game)}-SYSTEM_PROMPT.md`.toUpperCase(), promptText: fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : undefined, judgeModel: a.judgeModel as string | undefined, compare: pick.models, forced: pick.forced });
      } catch (e) { console.warn(`[driver] MLflow record failed for ${r.file}: ${(e as Error).message}`); }
    }
  }
  const failed = runs.filter((r) => !r.result?.passed).length;
  console.log(`[driver] ${runs.length - failed}/${runs.length} passed in ${Date.now() - t0}ms`);
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  let code = 0;
  await common(yargs(hideBin(process.argv)).scriptName("driver").strict().parserConfiguration({ "populate--": true }))
    .command("run <paths..>", "Run test cases", (y) => y.positional("paths", { type: "string", array: true, demandOption: true }), async (a) => { code = await run(a.paths as string[], a); })
    .command("how-to-test [game]", "Run a game's cases, or print its HOW_TO_TEST.md", (y) => y.positional("game", { type: "string", default: "." }), async (a) => {
      const game = String(a.game);
      if (casesOf(game).length) { code = await run([game], a); return; }
      const f = path.join(game, "HOW_TO_TEST.md");
      console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : `No HOW_TO_TEST.md in ${game}`);
    })
    .command("run-one <file>", false, (y) => y.positional("file", { type: "string", demandOption: true }), async (a) => {
      process.argv.splice(2); // the engine reads its own flags from argv when it loads; this command's flags are not for it
      const { runCase } = await import("../src/utils/case-run.js");
      const c = parseCase(String(a.file), { game: a.game as string | undefined, state: a.state as string | undefined, history: a.history as string | undefined, private: a.private as string | undefined });
      if (a.model) c.models.narrator = String(a.model);
      const real = console.log; console.log = (...x: unknown[]) => console.error(...x);
      const r = await runCase(c, { judgeModel: a.judgeModel as string | undefined, log: (l) => console.error(l) });
      console.log = real; console.log(RESULT_MARK + JSON.stringify(r));
    })
    .command("build [games..]", "Build prompt templates and extract inline images", (y) => y.positional("games", { type: "string", array: true, default: ["."] }).option("force", { type: "boolean", default: false }), async (a) => {
      for (const g of a.games as string[]) { const r = await buildGame(g, { force: a.force as boolean, log: (l) => console.log(l) }); console.log(`${g}: ${r.built.length} built, ${r.skipped.length} up to date, ${r.images.length} file(s) with images moved`); }
    })
    .command("check [games..]", "Every game folder needs VISION.md and HOW_TO_TEST.md", (y) => y.positional("games", { type: "string", array: true, default: [] }), (a) => {
      const games = (a.games as string[]).length ? (a.games as string[]) : gamesIn(path.join(ROOT, "imengs"));
      const bad = games.map(checkGameDocs).filter((c) => c.missing.length);
      for (const b of bad) console.log(`${b.game}: missing ${b.missing.join(", ")}`);
      console.log(bad.length ? `${bad.length} game(s) incomplete` : `${games.length} game(s) have both files`);
      code = bad.length ? 1 : 0;
    })
    .command("db <check>", "Build a fresh database from the migrations, seed it, run a query and check the exact outcome (a JSON file or string)", (y) => y.positional("check", { type: "string", demandOption: true }), async (a) => {
      const { dbCheckMain } = await import("../src/utils/db-check.js");
      code = await dbCheckMain(String(a.check));
    })
    .command("zip", "A zip of the files that changed since the last zip", (y) => y.option("src", { type: "string", default: env.ZIP_SRC || ROOT, describe: "Folder to pack (ZIP_SRC)" }).option("out", { type: "string", default: env.ZIP_OUT, describe: "Zip file to write (ZIP_OUT; default <src name>-changes-<n>.zip beside the folder)" }).option("all", { type: "boolean", default: false, describe: "Pack everything, not only changes" }).option("since", { type: "string", describe: "With no zip state yet: pack files changed after this zip file or date" }), async (a) => {
      const r = await zipSinceLast({ src: String(a.src), out: a.out as string | undefined, all: a.all as boolean, since: a.since as string | undefined });
      console.log(r.files.length ? `Packed ${r.files.length} file(s) into ${r.out}` : "Nothing changed since the last zip.");
    })
    .demandCommand(1).help().parseAsync();
  return code;
}

process.exit(await main());
