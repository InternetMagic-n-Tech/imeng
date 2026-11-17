/**
 * Every config.json format change is one file here, in order: `v1-to-v2.ts`, `v2-to-v3.ts`...
 * Add it to MIGRATIONS below; the current format version is 1 + the number of migrations, so it cannot be forgotten.
 * See README.md in this folder.
 */
export type Cfg = Record<string, unknown>;

export interface Migration {
  from: number;
  to: number;
  /** One line: what changed in the format. */
  title: string;
  /** config.json, forward: turn a `from` file into a `to` file. Pure; never mutate the input. */
  up(cfg: Cfg): Cfg;
  /** config.json, rollback: turn a `to` file back into a `from` file. Pure. Say in `rollbackNotes` what cannot be restored. */
  down(cfg: Cfg): Cfg;
  /** Saved sessions, forward: turn a stored session document written under `from` into one for `to` (pure). Without it a stored `from` session cannot be loaded after the upgrade (SESSION_SCHEMA decides). */
  session?(doc: Cfg): Cfg;
  /** What a person or agent must also change by hand going forward (SYSTEM_PROMPT.md, HOW_TO_TEST.md, saves). */
  notes: string[];
  /** The same for a rollback, including anything the format lost. */
  rollbackNotes: string[];
}

export const MIGRATIONS: Migration[] = [];

export const CONFIG_SCHEMA_VERSION = 1 + MIGRATIONS.length;

/** Check that a list is a gapless chain starting at version 1. */
export function chainError(list: Migration[]): string | null {
  for (const [i, m] of list.entries()) if (m.from !== i + 1 || m.to !== i + 2) return `migration ${i} must go from ${i + 1} to ${i + 2} (is ${m.from} to ${m.to})`;
  return null;
}

export interface MigrationRun {
  config: Cfg;
  /** The steps applied, in order (up or down). */
  steps: Migration[];
  direction: "up" | "down" | "none";
  error?: string;
}

/** Walk a config from one version to another, one step at a time (up or down). The input is never changed. */
export function runMigrations(cfg: Cfg, from: number, to: number, list: Migration[] = MIGRATIONS): MigrationRun {
  const run: MigrationRun = { config: { ...cfg }, steps: [], direction: from === to ? "none" : from < to ? "up" : "down" };
  const bad = chainError(list);
  if (bad) return { ...run, error: bad };
  if (from < 1 || to < 1 || from > list.length + 1 || to > list.length + 1) return { ...run, error: `versions must be between 1 and ${list.length + 1}` };
  for (let v = from; v !== to; v += run.direction === "up" ? 1 : -1) {
    const m = run.direction === "up" ? list[v - 1] : list[v - 2];
    run.config = { ...(run.direction === "up" ? m.up(run.config) : m.down(run.config)), schema_version: run.direction === "up" ? v + 1 : v - 1 };
    run.steps.push(m);
  }
  return run;
}
