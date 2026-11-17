import debug from "debug";
import util from "node:util";
import fs from "node:fs";
import { scrubForLog } from "./pii-filter.js";

/**
 * The `debug` package, with names under `proxy:`. Off unless the DEBUG environment variable says so (docs/OPERATIONS.md: "Debug output"). Everything written goes
 * through the PII scrub first (emails, phone and card numbers, id numbers, IPs, passwords and tokens, plus the game's own patterns), so turning debug
 * on never puts personal details in a terminal or a log file.
 */
export const NAMESPACES = ["boot", "process", "http", "engine", "phases", "crossings", "pii", "db", "rehydrate", "owner", "judge", "upstream", "redis", "session", "bucket"] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** DEBUG_FILE: every debug line is also appended (synchronously, so it survives a crash) to this file. Set without DEBUG it turns on proxy:*. */
const FILE = process.env.DEBUG_FILE || "";
if (FILE && !process.env.DEBUG) debug.enable("proxy:*");
debug.log = (...args: unknown[]): void => {
  const line = scrubForLog(util.format(...args)) + "\n";
  process.stderr.write(line);
  if (FILE) { try { fs.appendFileSync(FILE, line); } catch { /* a trail that cannot be written must not stop the game */ } }
};

const cache = new Map<string, debug.Debugger>();
/** `const log = dbg("phases"); log("moved %s -> %s", a, b)`. */
export function dbg(ns: Namespace): debug.Debugger {
  let d = cache.get(ns);
  if (!d) { d = debug(`proxy:${ns}`); cache.set(ns, d); }
  return d;
}
