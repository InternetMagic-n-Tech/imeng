import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { transparentSpawn } from "./spawn-helper.cjs"; // the project's helper: starts the program, here with its output captured
import { VISION, PRODUCTION } from "./config.js";
import { expand, venvEnv } from "./image-plan.js";
import { imageLease } from "./image-lease.js";
import { onKill } from "./shutdown.js";

/**
 * The vision module's Node side (config.json `vision`): a host-only Python worker (src/tools/vision/worker.py) in a venv, started on first use through transparentSpawn and spoken to in JSON lines.
 * The worker only runs models (YOLO-pose, the nudity detector); every rule stays in Node (seat-photo.ts judgePose, image-safety.ts). Fails closed: a worker that cannot start,
 * answers badly or times out is an error the callers turn into "no". With `url` the same JSON goes over HTTP to a worker someone else runs (Docker, production).
 * Outside production the worker is stopped after `idle_stop_s` idle seconds so its VRAM is returned; with device cuda each call runs inside the picture GPU lease.
 */
export interface Person { score: number; keypoints: { x: number; y: number; c: number }[] }
export interface Hit { label: string; score: number }
export interface VisionIO { tspawn?: typeof transparentSpawn; exists?: (p: string) => boolean; killGroup?: (pid: number) => void; fetch?: typeof fetch }

let io: VisionIO = {};
/** Tests inject fakes (a fake worker, a fake fetch). */
export const setVisionIO = (x: VisionIO | null): void => { io = x ?? {}; };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
interface Live { child: import("node:child_process").ChildProcess; pending: Map<number, Pending>; ready: Promise<void>; idle?: NodeJS.Timeout }
let live: Live | null = null;
let seq = 0;

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = (rel: string): string => { const c = [path.resolve(process.cwd(), rel), path.resolve(here, "..", rel), path.resolve(here, "..", "..", rel)]; return c.find((p) => (io.exists ?? fs.existsSync)(p)) ?? c[0]; };

/** Everything the doctor and the spawn need, with `${NAME}` filled; `missing` names unset variables. */
export function visionPlan(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; env: NodeJS.ProcessEnv; venv: string; weights: string; missing: string[] } {
  const v = VISION!, missing: string[] = [], f = (s: string): string => { const r = expand(s, env); missing.push(...r.missing); return r.text; };
  const venv = v.venv ? f(v.venv) : "", weights = v.poseWeights ? f(v.poseWeights) : "";
  let command = v.python, wenv: NodeJS.ProcessEnv = { ...env, VISION_DEVICE: v.device, VISION_POSE_WEIGHTS: weights };
  if (venv) ({ env: wenv, command } = venvEnv(venv, command, wenv, io.exists ?? fs.existsSync));
  return { command, args: [scriptPath(v.script)], env: wenv, venv, weights, missing };
}

function lineWriter(onLine: (l: string) => void): Writable {
  let buf = "";
  return new Writable({ write(chunk, _enc, cb) { buf += chunk.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } cb(); } });
}

function kill(w: Live): void {
  if (w.idle) clearTimeout(w.idle);
  const pid = w.child.pid;
  if (pid) { try { (io.killGroup ?? ((p: number) => process.kill(process.platform === "win32" ? p : -p, "SIGTERM")))(pid); } catch { /* already gone */ } }
}
/** Stop the worker now (shutdown, tests). */
export function stopVision(): void { if (live) { const w = live; live = null; kill(w); for (const p of w.pending.values()) { clearTimeout(p.timer); p.reject(new Error("the vision worker was stopped")); } w.pending.clear(); } }

function start(): Live {
  const v = VISION!;
  if (PRODUCTION && !v.url) throw new Error("production: the vision worker is expected at vision.url and is not started by this process");
  const p = visionPlan();
  if (p.missing.length) throw new Error(`vision needs the environment variable(s): ${[...new Set(p.missing)].join(", ")}`);
  if (p.venv && !(io.exists ?? fs.existsSync)(p.venv)) throw new Error(`vision.venv ${p.venv} does not exist (create it with: python3 -m venv ${p.venv})`);
  const pending = new Map<number, Pending>();
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  const out = lineWriter((l) => {
    let m: any; try { m = JSON.parse(l); } catch { return; }
    const q = pending.get(Number(m?.id)); if (!q) return;
    pending.delete(Number(m.id)); clearTimeout(q.timer);
    m.ok ? q.resolve(m) : q.reject(new Error(String(m.error ?? "the vision worker failed")));
  });
  const { child, promise } = (io.tspawn ?? transparentSpawn)(p.command, p.args, p.env, undefined, { detached: true }, { log: () => null, stdout: out, stderr: sink });
  const w: Live = { child, pending, ready: Promise.resolve() };
  const dead = (why: string): void => { if (live === w) live = null; if (w.idle) clearTimeout(w.idle); for (const q of pending.values()) { clearTimeout(q.timer); q.reject(new Error(why)); } pending.clear(); };
  promise.then(() => dead("the vision worker exited"), (e: Error) => dead(`the vision worker stopped: ${e.message}`));
  child.on("error", (e: Error) => dead(`the vision worker did not start: ${e.message}`));
  onKill(() => kill(w)); process.on("exit", () => kill(w));
  return w;
}

const ask = (w: Live, op: string, image: string | undefined, ms: number): Promise<any> => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { w.pending.delete(id); reject(new Error(`the vision worker did not answer in ${ms / 1000} s`)); }, ms);
  w.pending.set(id, { resolve, reject, timer });
  try { w.child.stdin!.write(JSON.stringify({ id, op, image }) + "\n"); } catch (e) { w.pending.delete(id); clearTimeout(timer); reject(e as Error); }
});

async function call(op: "pose" | "censor", bytes: Buffer): Promise<any> {
  const v = VISION;
  if (!v) throw new Error("vision is not configured");
  const run = async (): Promise<any> => {
    const image = bytes.toString("base64");
    if (v.url) { // a worker run by someone else: the same JSON over HTTP
      const r = await (io.fetch ?? fetch)(v.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, op, image }), signal: AbortSignal.timeout(v.timeoutS * 1000) });
      if (!r.ok) throw new Error(`the vision service answered ${r.status}`);
      const m: any = await r.json();
      if (m?.ok === false) throw new Error(String(m.error ?? "the vision service failed"));
      return m;
    }
    const w = (live ??= start());
    if (w.idle) clearTimeout(w.idle);
    try { return await ask(w, op, image, v.timeoutS * 1000); }
    finally {
      if (live === w && v.idleStopS > 0) { w.idle = setTimeout(() => { if (live === w) { live = null; kill(w); } }, v.idleStopS * 1000); w.idle.unref?.(); } // the GPU sleeps when nobody is asking
    }
  };
  const lease = v.device === "cuda" ? imageLease() : null;
  return lease ? lease.run(run) : run();
}

/** The people in a picture: score and 17 COCO keypoints each (x, y, confidence). */
export async function visionPose(bytes: Buffer): Promise<Person[]> {
  const m = await call("pose", bytes);
  return (Array.isArray(m.people) ? m.people : []).map((p: any) => ({ score: Number(p?.score) || 0, keypoints: (Array.isArray(p?.keypoints) ? p.keypoints : []).slice(0, 17).map((k: any) => ({ x: Number(k?.[0]) || 0, y: Number(k?.[1]) || 0, c: Number(k?.[2]) || 0 })) }));
}

/** What the image censor found: every label with its score (Node decides which labels block). */
export async function visionCensor(bytes: Buffer): Promise<Hit[]> {
  const m = await call("censor", bytes);
  return (Array.isArray(m.hits) ? m.hits : []).map((h: any) => ({ label: String(h?.label ?? ""), score: Number(h?.score) || 0 }));
}
