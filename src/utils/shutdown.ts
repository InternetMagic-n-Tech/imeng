import os from "node:os";
import { dbg } from "./debug.js";

// Exit handling. Two kinds of cleanup are registered by the modules that start things:
//   onKill(fn)      synchronous "stop what we spawned" (e.g. child.kill). Runs on EVERY exit signal.
//   onShutdown(fn)  asynchronous graceful cleanup (flush logs, purge entries). Runs only for a
//                   keyboard exit.
//
// Keyboard exit (Ctrl+C = SIGINT, Ctrl+\ = SIGQUIT, from an interactive terminal):
//   kill what we spawned, run the graceful cleanup (bounded by a timeout), then exit by re-raising
//   the ORIGINAL signal, so the exit status really is "killed by SIGINT" (130 in a shell).
// Anything else (SIGTERM from `docker stop`, SIGHUP, SIGINT without a terminal, ...):
//   kill what we spawned and re-raise the signal right away. No awaiting, no try/catch, no logging:
//   anything slower could delay other processes' exits.
type Task = () => unknown | Promise<unknown>;
type Killer = () => void;

const tasks: Task[] = [];
const killers: Killer[] = [];
let exiting = false;

/** Register asynchronous graceful cleanup (keyboard exits only). */
export function onShutdown(fn: Task): void {
  tasks.push(fn);
}

/** Register a synchronous, instant "stop what we started" function (runs on every exit signal). */
export function onKill(fn: Killer): void {
  killers.push(fn);
}

const KEYBOARD_SIGNALS = new Set<NodeJS.Signals>(["SIGINT", "SIGQUIT"]);

/** A keyboard exit is Ctrl+C / Ctrl+\ typed in an interactive terminal. */
export const isKeyboardExit = (signal: NodeJS.Signals, isTTY: boolean): boolean => isTTY && KEYBOARD_SIGNALS.has(signal);

/**
 * Exit the way the signal would have: drop our handler(s) so the default action applies, then send
 * the signal to ourselves. If that somehow doesn't end the process, fall back to the conventional
 * 128+signal exit code.
 */
export function reRaise(signal: NodeJS.Signals, exit: (code: number) => void = process.exit): void {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  const number = os.constants.signals[signal];
  setTimeout(() => exit(128 + number), 100);
}

export interface ExitOptions {
  keyboard: boolean;
  raise?: (signal: NodeJS.Signals) => void;
  timeoutMs?: number;
}

/** Handle an exit signal. Exported for tests; the real handlers are registered below. */
export async function exitOnSignal(signal: NodeJS.Signals, { keyboard, raise = reRaise, timeoutMs = 8000 }: ExitOptions): Promise<void> {
  if (exiting) return;
  exiting = true;
  dbg("process")("signal %s (keyboard %s)", signal, keyboard);

  for (const kill of killers) kill(); // synchronous: stop what we started, on every exit

  if (keyboard) {
    console.log(`\n${signal} received, shutting down...`);
    const timeout = new Promise((r) => setTimeout(r, timeoutMs).unref());
    await Promise.race([Promise.allSettled(tasks.map(async (fn) => fn())), timeout]);
  }
  raise(signal);
}

/** Test helper: forget registrations and allow another exit. */
export function _resetShutdown(): void {
  tasks.length = 0;
  killers.length = 0;
  exiting = false;
}

for (const sig of ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => void exitOnSignal(sig, { keyboard: isKeyboardExit(sig, Boolean(process.stdin.isTTY)) }));
}
