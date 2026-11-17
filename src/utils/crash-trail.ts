import { dbg } from "./debug.js";

/**
 * What the process says as it dies, and how it is doing while it lives (proxy:process). Memory is sampled every
 * DEBUG_HEARTBEAT_MS (default 30000) only while that namespace is on, so a crash or an out-of-memory kill leaves a trail.
 */
const log = dbg("process");
let started = false;
export function startCrashTrail(): void {
  if (started) return;
  started = true;
  process.on("uncaughtExceptionMonitor", (e) => { log("UNCAUGHT EXCEPTION %s", e?.stack ?? e); }); // a monitor only watches: the process still dies as it would
  process.on("unhandledRejection", (e) => { log("UNHANDLED REJECTION %s", (e as Error)?.stack ?? e); throw e; }); // rethrown: with no handler Node would crash here, and still does
  process.on("warning", (w) => { log("warning %s: %s", w.name, w.message); });
  process.on("exit", (code) => { log("exit, code %d", code); });
  log("start pid %d, node %s", process.pid, process.version);
  if (log.enabled) {
    const t = setInterval(() => { const m = process.memoryUsage(); log("heartbeat rss %d MB, heap %d MB, up %d s", Math.round(m.rss / 1048576), Math.round(m.heapUsed / 1048576), Math.round(process.uptime())); }, Number(process.env.DEBUG_HEARTBEAT_MS) || 30000);
    t.unref();
  }
}
