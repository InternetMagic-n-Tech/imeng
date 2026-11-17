import { readState, type Expected } from "./db-migrations.js";
import { dbg } from "./debug.js";
import type { Db } from "./db.js";

/**
 * Fails closed on a bad version stamp. The database is the source of truth: its applied migrations and its stamp rows must match what this code expects.
 * Checked on a timer and before every game turn. A mismatch (database ahead, behind, or stamped by another version) stops the instance: turns are refused,
 * /healthz answers 503 and the process exits with 1. An unreachable database is an ordinary error: logged, and the last verdict stands.
 */

export interface Verdict { ok: boolean; reason?: string; expected?: string; found?: string }

export function judgeState(found: { applied: string[]; appliedGame?: string[]; stamp: Record<string, string> }, want: Expected): Verdict {
  const ahead = found.applied.filter((n) => !want.migrations.includes(n));
  if (ahead.length) return { ok: false, reason: "database is ahead of this code (a newer deployment migrated it)", expected: want.migrations.at(-1) ?? "none", found: ahead.at(-1) };
  const behind = want.migrations.filter((n) => !found.applied.includes(n));
  if (behind.length) return { ok: false, reason: "migrations are pending (run db:migrate)", expected: want.migrations.at(-1) ?? "none", found: found.applied.at(-1) ?? "none" };
  if (want.gameMigrations && found.appliedGame) { // the imeng's own migrations, judged the same way
    const gAhead = found.appliedGame.filter((n) => !want.gameMigrations!.includes(n)), gBehind = want.gameMigrations.filter((n) => !found.appliedGame!.includes(n));
    if (gAhead.length) return { ok: false, reason: "the game's database is ahead of this code (a newer deployment migrated it)", expected: want.gameMigrations.at(-1) ?? "none", found: gAhead.at(-1) };
    if (gBehind.length) return { ok: false, reason: "the game's migrations are pending (run db:migrate)", expected: want.gameMigrations.at(-1) ?? "none", found: found.appliedGame.at(-1) ?? "none" };
  }
  for (const k of ["rules", "game", "proxy"] as const) {
    if (found.stamp[k] !== want[k]) return { ok: false, reason: `${k} version stamp differs`, expected: want[k], found: found.stamp[k] ?? "none" };
  }
  return { ok: true };
}

export interface GuardOpts { db: Db; expected: Expected; intervalMs: number; exit?: (code: number) => void; logOnly?: boolean; log?: (m: string) => void }

export class StateGuard {
  verdict: Verdict = { ok: true };
  private timer?: NodeJS.Timeout;
  private busy: Promise<Verdict> | null = null;
  constructor(private o: GuardOpts) {}

  /** Read the stamp now and update the verdict. */
  check(): Promise<Verdict> {
    return (this.busy ??= (async () => {
      try {
        const v = judgeState(await readState(this.o.db, this.o.expected.gameId), this.o.expected);
        if (!v.ok && this.verdict.ok) this.trip(v);
        else if (v.ok && !this.verdict.ok && this.o.logOnly) this.verdict = v;
        return this.verdict;
      } catch (e) {
        (this.o.log ?? console.warn)(`state check could not read the database: ${(e as Error).message}`);
        return this.verdict;
      } finally { this.busy = null; }
    })());
  }

  private trip(v: Verdict): void {
    this.verdict = v;
    dbg("db")("state problem: %s (expected %s, found %s)", v.reason, v.expected, v.found);
    (this.o.log ?? console.error)(`State version problem: ${v.reason} (expected ${v.expected}, found ${v.found}).${this.o.logOnly ? " Carrying on (STATE_EXIT=off)." : " Stopping."}`);
    if (!this.o.logOnly) { this.stop(); (this.o.exit ?? process.exit)(1); }
  }

  start(): void { this.stop(); this.timer = setInterval(() => void this.check(), this.o.intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
