import type { Server } from "node:http";
import { bucketOn, bucketReady } from "./bucket.js";
import { startCrashTrail } from "./crash-trail.js";
import { dbg } from "./debug.js";
const boot = dbg("boot");
import { app } from "../app.js";
import { startInterfaces } from "../modules/index.js";
import { productionNotes } from "./production.js";
import { PORT, IMENG_PATH, MODEL_ID, INTERFACES, DEAL, BETTING, DATABASE_URL, PRODUCTION, config } from "./config.js";
import { iconUrl, readIcon } from "./icon.js";
import { PUBLIC_URL } from "./image-config.js";
import { PERSIST, PREFLIGHT, PREFLIGHT_IGNORE } from "./cli.js";
import { loadSessions, redisSchemaProblem } from "./sessions.js";
import { SchemaMismatch } from "./session-schema.js";
import { startState, stopState } from "./db-state.js";
import { startRedis } from "./logger.js";
import { startJudgeInstance } from "./judge.js";
import { realSys } from "./doctor-sys.js";
import { buildSettings } from "./doctor-settings.js";
import { runDoctor, isProblem } from "./doctor.js";
import { formatReport } from "./doctor-format.js";
import type { Settings, Sys } from "./doctor.js";

export interface BootstrapOptions {
  /** Run the doctor first and refuse to start on any failure. Defaults to --preflight / PREFLIGHT=1. */
  preflight?: boolean;
  /** Doctor finding ids to ignore during preflight. */
  ignore?: string[];
  /** Listen port (default PORT). 0 picks a free one. */
  port?: number;
  /** Test hooks. */
  sys?: Sys;
  settings?: Settings;
}

/**
 * Doctor checks before starting. Prints the problems (warnings and failures) and returns false if there
 * is any failure, so a broken setup stops here instead of misbehaving mid-game. Warnings never block.
 */
/** Where the process listens: PROXY_BIND, else every interface in production (the container; compose publishes the port on the host's PROXY_BIND), else localhost. */
export const listenHost = (): string => process.env.PROXY_BIND?.trim() || (PRODUCTION ? "0.0.0.0" : "127.0.0.1");

export async function preflight(sys: Sys, settings: Settings, ignore: string[] = []): Promise<boolean> {
  const report = await runDoctor(sys, settings, { ignore });
  const failed = report.findings.some((f) => f.level === "fail");
  const problems = report.findings.filter(isProblem).length;
  if (problems) for (const line of formatReport(report, { onlyProblems: true, gameDir: settings.gameDir })) console.log(line);
  else console.log(`Preflight: all ${report.findings.length} checks passed.`);
  if (failed) console.error("Refusing to start: fix the failures above (or run without --preflight).");
  return !failed;
}

/**
 * Start everything and begin listening. Resolves to the HTTP server, or null if it could not start
 * (a failed preflight, or the port being taken); the caller decides how to exit.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<Server | null> {
  startCrashTrail();
  boot("bootstrap: preflight %s", opts.preflight ?? PREFLIGHT);
  if (opts.preflight ?? PREFLIGHT) {
    const ok = await preflight(opts.sys ?? realSys(), opts.settings ?? buildSettings(), opts.ignore ?? PREFLIGHT_IGNORE);
    if (!ok) return null;
  }
  for (const n of productionNotes()) console.warn(n);
  boot("database state check");
  const state = await startState();
  if (!state.ok) { console.error(`Refusing to start: ${state.reason} (expected ${state.expected}, found ${state.found}). Run: npm run db:migrate`); await stopState(); return null; }
  if ((DEAL === "server" || BETTING === "server") && !DATABASE_URL) { console.error("Refusing to start: this game deals or bets on the server (deal/betting \"server\") and keeps its record in the database. Set DATABASE_URL (postgres:// or sqlite:<file>)."); await stopState(); return null; }
  boot("bucket");
  if (bucketOn()) await bucketReady();
  boot("redis");
  await startRedis(); // before the sessions: where they live depends on whether Redis is up
  try {
    loadSessions();
    const problem = await redisSchemaProblem();
    if (problem) throw new SchemaMismatch(problem);
  } catch (e) {
    if (!(e instanceof SchemaMismatch)) throw e;
    console.error(e.message.startsWith("Refusing") ? e.message : `Refusing to start: ${e.message}. Fix: write the migration's session step (utils/migrations/README.md), clear the saves (npm run sessions -- clear), or set SESSION_SCHEMA=warn to start anyway.`);
    return null;
  }
  boot("sessions loaded; judge instance");
  await startJudgeInstance();
  boot("interfaces");
  await startInterfaces(app, INTERFACES, ["openwebui"]); // Open WebUI's routes are already mounted by app.ts

  const port = opts.port ?? PORT;
  return new Promise<Server | null>((resolve) => {
    let settled = false;
    const fail = (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Stop the other process or set PORT.` : `Could not listen on port ${port}: ${e.message}`);
      resolve(null);
    };
    // Express 5 also calls this callback with the error when listening fails, so handle both.
    const server = app.listen(port, listenHost(), (err?: Error) => {
      if (err) return fail(err);
      settled = true;
      const actual = (server.address() as { port: number }).port;
      boot("listening on %d", actual);
      console.log(`Game proxy on :${actual} (game dir: ${IMENG_PATH}, model id: ${MODEL_ID}${PERSIST ? "" : ", --no-persist"})`);
      if (config.icon && !process.env.IMENG_HUB_CHILD) console.log(readIcon(IMENG_PATH, config.icon) ? `Game picture: ${iconUrl(PUBLIC_URL, MODEL_ID)} (Open WebUI's model editor takes an uploaded file: upload ${config.icon} from the game folder in Workspace > Models)` : `config.json icon "${config.icon}" is not usable (a png, jpg, webp or gif file of up to 2 MB in the game folder)`);
      resolve(server);
    });
    server.once("error", fail);
  });
}
