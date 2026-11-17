/*
 * How hard the driver and its test runs push the machine. Production is high performance (many tasks at once, few retries);
 * anything else is gentle (one at a time, more patience) so an IDE on the same machine is not starved. Each number is an env var
 * (DRIVER_CONCURRENCY, DRIVER_RETRIES, DRIVER_BACKOFF_MS, DRIVER_BACKOFF_MAX_MS, DRIVER_TASK_TIMEOUT_MS); a command-line flag passed as `over` wins.
 */

export interface Profile { name: "high" | "low"; concurrency: number; retries: number; backoffMs: number; backoffMaxMs: number; taskTimeoutMs: number }

const HIGH: Profile = { name: "high", concurrency: 8, retries: 2, backoffMs: 250, backoffMaxMs: 5_000, taskTimeoutMs: 120_000 };
const LOW: Profile = { name: "low", concurrency: 1, retries: 3, backoffMs: 1_000, backoffMaxMs: 15_000, taskTimeoutMs: 300_000 };

const num = (v: string | undefined, d: number, min: number): number => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? Math.max(min, Math.floor(n)) : d; };

export function profileFor(env: NodeJS.ProcessEnv = process.env, over: Partial<Profile> = {}): Profile {
  const base = env.NODE_ENV === "production" ? HIGH : LOW;
  const p: Profile = {
    name: base.name,
    concurrency: num(env.DRIVER_CONCURRENCY, base.concurrency, 1),
    retries: num(env.DRIVER_RETRIES, base.retries, 0),
    backoffMs: num(env.DRIVER_BACKOFF_MS, base.backoffMs, 1),
    backoffMaxMs: num(env.DRIVER_BACKOFF_MAX_MS, base.backoffMaxMs, 1),
    taskTimeoutMs: num(env.DRIVER_TASK_TIMEOUT_MS, base.taskTimeoutMs, 1),
  };
  for (const k of Object.keys(over) as (keyof Profile)[]) if (over[k] !== undefined) (p as any)[k] = over[k];
  return p;
}
