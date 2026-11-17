import type { ImagesConfig } from "./types.js";

/** ${NAME} placeholders for the renderer process. Pure: no config, no machine access. */

/** Replace ${NAME} from `env`. Returns the text and the names that were not set. */
export function expand(text: string, env: NodeJS.ProcessEnv): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\$\{(\w+)\}/g, (_m, k: string) => { const v = env[k]; if (v === undefined || v === "") { missing.push(k); return ""; } return v; });
  return { text: out, missing };
}

export interface Planned { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; venv?: string }

/** The command to run with every placeholder filled in; throws naming the variables that are not set. */
export function plan(p: NonNullable<ImagesConfig["process"]>, env: NodeJS.ProcessEnv = process.env): Planned {
  const missing = new Set<string>();
  const f = (s: string): string => { const r = expand(s, env); r.missing.forEach((m) => missing.add(m)); return r.text; };
  const out: Planned = {
    command: f(p.command), args: (p.args ?? []).map(f), cwd: p.cwd ? f(p.cwd) : undefined, venv: p.venv ? f(p.venv) : undefined,
    env: { ...env, ...Object.fromEntries(Object.entries(p.env ?? {}).map(([k, v]) => [k, f(v)])) },
  };
  if (missing.size) throw new Error(`images.process needs the environment variable(s): ${[...missing].join(", ")}`);
  return out;
}

/**
 * What `source venv/bin/activate` does to a process: VIRTUAL_ENV set, the venv's bin first on PATH, PYTHONHOME dropped. Applied to the child's
 * environment only, so the engine's own is never touched and there is nothing to deactivate: stopping the child ends it. A bare python/python3/pip
 * command is replaced by the venv's own binary when it exists.
 */
export function venvEnv(dir: string, command: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, windows = process.platform === "win32"): { env: NodeJS.ProcessEnv; command: string } {
  const bin = `${dir.replace(/[\\/]+$/, "")}${windows ? "\\Scripts" : "/bin"}`, sep = windows ? ";" : ":";
  const out: NodeJS.ProcessEnv = { ...env, VIRTUAL_ENV: dir, PATH: `${bin}${sep}${env.PATH ?? ""}` };
  delete out.PYTHONHOME;
  const own = /^(python3?|pip3?)$/.test(command) ? `${bin}${windows ? "\\" : "/"}${command}${windows ? ".exe" : ""}` : "";
  return { env: out, command: own && exists(own) ? own : command };
}
