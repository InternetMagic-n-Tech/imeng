import pLimit from "p-limit";
import pRetry from "p-retry";
import { profileFor } from "./run-profile.js";
import type { Profile } from "./run-profile.js";

/*
 * Staged pipelines: an array of functions that return promises, a map of then / catch / finally handlers for that stage, the next
 * array, the next map, and so on. What a stage's `then` returns becomes the next stage's input; `catch` may return a stand-in
 * (the stage then counts as done) or throw (the pipeline stops, after `finally`).
 *   mode "all"        every task must succeed (default; the first failure fails the stage)
 *   mode "allSettled" every task runs; results are { status, value | reason } and nothing fails the stage
 *   mode "race"       the first task to finish decides the stage
 *   mode "series"     one after another, each given the previous result
 * Every task is retried with exponential backoff and is capped by the profile's concurrency and timeout.
 */

export type Task<I = unknown, O = unknown> = (input: I, ctx: StageCtx) => Promise<O>;
export interface Handlers<R = unknown, N = unknown> { then?: (results: R, ctx: StageCtx) => N | Promise<N>; catch?: (err: unknown, ctx: StageCtx) => N | Promise<N>; finally?: (ctx: StageCtx) => void | Promise<void> }
export interface StageOpts { mode?: "all" | "allSettled" | "race" | "series"; retries?: number; concurrency?: number }
export interface Stage { name?: string; tasks: Task<any, any>[]; handlers?: Handlers<any, any>; opts?: StageOpts }
export interface StageCtx { stage: number; name: string; profile: Profile; log: (line: string) => void }
export interface RunOpts { profile?: Profile; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> }

const settle = async <T,>(p: Promise<T>): Promise<PromiseSettledResult<T>> => p.then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));

export async function runStages(stages: Stage[], input?: unknown, run: RunOpts = {}): Promise<unknown> {
  const profile = run.profile ?? profileFor();
  const log = run.log ?? ((l: string) => console.log(l));
  let carry = input;
  for (const [i, st] of stages.entries()) {
    const ctx: StageCtx = { stage: i, name: st.name ?? `stage ${i + 1}`, profile, log };
    const mode = st.opts?.mode ?? "all";
    const limit = pLimit(st.opts?.concurrency ?? profile.concurrency);
    const retries = st.opts?.retries ?? profile.retries;
    const t0 = Date.now();
    const once = (t: Task, arg: unknown) => pRetry(
      () => Promise.race([t(arg, ctx), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`task timed out after ${profile.taskTimeoutMs}ms`)), profile.taskTimeoutMs).unref())]),
      { retries, factor: 2, minTimeout: profile.backoffMs, maxTimeout: profile.backoffMaxMs, randomize: false, onFailedAttempt: (e: any) => log(`${ctx.name}: attempt ${e.attemptNumber} failed (${e.message}); ${e.retriesLeft} left`) },
    );
    try {
      let results: unknown;
      if (mode === "series") { const out: unknown[] = []; let prev = carry; for (const t of st.tasks) { prev = await once(t, prev); out.push(prev); } results = out; }
      else if (mode === "race") results = await Promise.race(st.tasks.map((t) => limit(() => once(t, carry))));
      else if (mode === "allSettled") results = await Promise.all(st.tasks.map((t) => settle(limit(() => once(t, carry)))));
      else results = await Promise.all(st.tasks.map((t) => limit(() => once(t, carry))));
      carry = st.handlers?.then ? await st.handlers.then(results, ctx) : results;
      log(`${ctx.name}: done in ${Date.now() - t0}ms`);
    } catch (e) {
      log(`${ctx.name}: failed in ${Date.now() - t0}ms (${(e as Error).message})`);
      if (!st.handlers?.catch) throw e;
      carry = await st.handlers.catch(e, ctx);
    } finally {
      await st.handlers?.finally?.(ctx);
    }
  }
  return carry;
}
