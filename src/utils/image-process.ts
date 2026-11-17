import fs from "node:fs";
import { spawn } from "node:child_process";
import { transparentSpawn } from "./spawn-helper.cjs"; // the project's helper: pipes the program's output through and logs its start and exit
import { IMAGES, IMAGE_URL } from "./image-config.js";
import { PRODUCTION } from "./config.js";
import { onKill } from "./shutdown.js";
import { plan, venvEnv } from "./image-plan.js";

export { expand, plan } from "./image-plan.js";

/** Starting the renderer when config.json describes a process for it and nothing answers yet, outside production (there it must already be running). It is left running unless `stop_on_exit`. */

let starting: Promise<void> | null = null;

export interface ProcIO { fetch?: typeof fetch; spawn?: typeof spawn; tspawn?: typeof transparentSpawn; sleep?: (ms: number) => Promise<void>; exists?: (p: string) => boolean; killGroup?: (pid: number) => void }

export function ensureRenderer(io: ProcIO = {}): Promise<void> {
  const p = IMAGES?.process;
  if (!p) return Promise.resolve();
  return (starting ??= start(p, io).finally(() => { starting = null; }));
}

async function start(p: NonNullable<NonNullable<typeof IMAGES>["process"]>, io: ProcIO): Promise<void> {
  const f = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const up = (): Promise<boolean> => f(p.ready_url || IMAGE_URL, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  if (await up()) return;
  if (PRODUCTION) throw new Error(`production: the renderer is expected at ${p.ready_url || IMAGE_URL} and is not started by this process`);
  let run;
  try { run = plan(p); } catch (e) { console.warn((e as Error).message); throw e; }
  let { command, env } = run;
  if (run.venv) {
    if (!(io.exists ?? fs.existsSync)(run.venv)) throw new Error(`images.process.venv ${run.venv} does not exist (create it with: python3 -m venv ${run.venv})`);
    ({ env, command } = venvEnv(run.venv, command, env, io.exists ?? fs.existsSync));
  }
  const stop = p.stop_on_exit ?? !!p.venv;
  if (stop) { // tied to this app: output piped through the project's helper, stopped with its whole process group
    const { child, promise } = (io.tspawn ?? transparentSpawn)(command, run.args, env, run.cwd, { detached: true });
    promise.catch((e: Error) => console.warn("renderer stopped:", e.message));
    child.on("error", (e: Error) => console.warn("renderer did not start:", e.message));
    const killGroup = io.killGroup ?? ((pid: number) => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM"); } catch { /* already gone */ } });
    let done = false;
    const stopIt = (): void => { if (!done && child.pid) { done = true; killGroup(child.pid); } };
    onKill(stopIt); process.on("exit", stopIt);
  } else { // left running when the app stops
    const child = (io.spawn ?? spawn)(command, run.args, { env, cwd: run.cwd, stdio: "ignore", detached: true });
    child.on("error", (e: Error) => console.warn("renderer did not start:", e.message));
    child.unref();
  }
  for (let i = 0; i < 120 && !(await up()); i++) await sleep(1000);
  if (!(await up())) throw new Error("the renderer did not start answering in time");
}
