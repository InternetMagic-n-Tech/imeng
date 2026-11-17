// Type declarations for ./spawn-helper.cjs (the helper itself is left untouched).
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

/** Where a spawned process' output goes. Any missing piece falls back to the parent's stdout/stderr. */
export interface SpawnIO {
  log?: (...args: unknown[]) => unknown;
  stdout?: Writable;
  stderr?: Writable;
}

/** A factory returning a SpawnIO (e.g. muteTSpawn / nullTSpawn). */
export type SpawnIOFactory = () => SpawnIO;

export interface SpawnResult {
  /** Resolves when the process exits with code 0 (or is killed by a signal); rejects on any other exit code. */
  promise: Promise<{ exec: string; spawnParms: string[] }>;
  child: ChildProcess;
}

/**
 * Spawns a process, piping its output through (or to `custom`) and logging start/exit.
 * `env` may be an environment object, or the `muteTSpawn` / `nullTSpawn` marker functions.
 */
export function transparentSpawn(
  exec: string,
  spawnParms?: string[],
  env?: NodeJS.ProcessEnv | SpawnIOFactory,
  cwd?: string,
  opts?: SpawnOptions,
  custom?: SpawnIO | SpawnIOFactory | null,
): SpawnResult;

/** Discards stdout, keeps stderr. */
export function muteTSpawn(): SpawnIO;

/** Same as transparentSpawn but silent by default (stdout discarded, no start/exit logging). */
export function silentSpawn(
  exec: string,
  spawnParms?: string[],
  env?: NodeJS.ProcessEnv | SpawnIOFactory,
  cwd?: string,
  opts?: SpawnOptions,
  custom?: SpawnIO | SpawnIOFactory | null,
): SpawnResult;
