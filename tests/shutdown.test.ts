import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import os from "node:os";
import { onShutdown, onKill, exitOnSignal, isKeyboardExit, reRaise, _resetShutdown } from "../src/utils/shutdown.js";

let log: jest.SpiedFunction<typeof console.log>;
let warn: jest.SpiedFunction<typeof console.warn>;
let error: jest.SpiedFunction<typeof console.error>;

beforeEach(() => {
  _resetShutdown();
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  error = jest.spyOn(console, "error").mockImplementation(() => {});
  log.mockClear(); warn.mockClear(); error.mockClear(); // spies persist across tests, so start each clean
});
afterEach(() => { jest.useRealTimers(); });

describe("isKeyboardExit", () => {
  it("is Ctrl+C or Ctrl+\\ typed in a terminal, nothing else", () => {
    expect(isKeyboardExit("SIGINT", true)).toBe(true);
    expect(isKeyboardExit("SIGQUIT", true)).toBe(true);
    expect(isKeyboardExit("SIGINT", false)).toBe(false); // e.g. `kill -INT`, Docker, CI
    expect(isKeyboardExit("SIGTERM", true)).toBe(false);
    expect(isKeyboardExit("SIGHUP", true)).toBe(false);
  });
});

describe("keyboard exit: clean up, then exit with the original signal", () => {
  it("kills what was spawned first, runs graceful cleanup, then re-raises the same signal", async () => {
    const order: string[] = [];
    onKill(() => { order.push("kill"); });
    onShutdown(async () => { await new Promise((r) => setTimeout(r, 5)); order.push("cleanup"); });
    const raise = jest.fn((s: NodeJS.Signals) => { order.push("raise:" + s); });
    await exitOnSignal("SIGINT", { keyboard: true, raise });
    expect(order).toEqual(["kill", "cleanup", "raise:SIGINT"]);
  });

  it("re-raises whichever keyboard signal it got", async () => {
    const raise = jest.fn();
    await exitOnSignal("SIGQUIT", { keyboard: true, raise });
    expect(raise).toHaveBeenCalledWith("SIGQUIT");
  });

  it("a failing cleanup task does not stop the others or the exit", async () => {
    const ran = jest.fn();
    onShutdown(() => { throw new Error("boom"); });
    onShutdown(ran);
    const raise = jest.fn();
    await exitOnSignal("SIGINT", { keyboard: true, raise });
    expect(ran).toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith("SIGINT");
  });

  it("gives up on a cleanup that never finishes, then exits anyway", async () => {
    onShutdown(() => new Promise(() => {}));
    const raise = jest.fn();
    await exitOnSignal("SIGINT", { keyboard: true, raise, timeoutMs: 20 });
    expect(raise).toHaveBeenCalledWith("SIGINT");
  });

  it("announces the shutdown", async () => {
    await exitOnSignal("SIGINT", { keyboard: true, raise: jest.fn() });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SIGINT received, shutting down"));
  });
});

describe("any other exit: kill and go, nothing slow", () => {
  it("kills spawned processes and re-raises immediately, skipping graceful cleanup", async () => {
    const kill = jest.fn();
    const cleanup = jest.fn();
    onKill(kill);
    onShutdown(cleanup);
    const raise = jest.fn();
    await exitOnSignal("SIGTERM", { keyboard: false, raise });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not wait for anything: re-raises before a slow task could finish", async () => {
    let slowDone = false;
    onShutdown(() => new Promise((r) => setTimeout(() => { slowDone = true; r(undefined); }, 200)));
    const raise = jest.fn();
    await exitOnSignal("SIGHUP", { keyboard: false, raise });
    expect(raise).toHaveBeenCalledWith("SIGHUP");
    expect(slowDone).toBe(false);
  });

  it("writes nothing to the console", async () => {
    onKill(() => {});
    await exitOnSignal("SIGTERM", { keyboard: false, raise: jest.fn() });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not catch: a throwing killer surfaces instead of being swallowed", async () => {
    onKill(() => { throw new Error("kill failed"); });
    const raise = jest.fn();
    await expect(exitOnSignal("SIGTERM", { keyboard: false, raise })).rejects.toThrow("kill failed");
  });

  it("treats a SIGINT without a terminal like any other exit", async () => {
    const cleanup = jest.fn();
    onShutdown(cleanup);
    const raise = jest.fn();
    await exitOnSignal("SIGINT", { keyboard: isKeyboardExit("SIGINT", false), raise });
    expect(cleanup).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith("SIGINT");
  });
});

it("only exits once even if signalled repeatedly", async () => {
  const kill = jest.fn();
  onKill(kill);
  const raise = jest.fn();
  await exitOnSignal("SIGINT", { keyboard: true, raise });
  await exitOnSignal("SIGINT", { keyboard: true, raise });
  expect(kill).toHaveBeenCalledTimes(1);
  expect(raise).toHaveBeenCalledTimes(1);
});

describe("reRaise", () => {
  it("removes our handlers and sends the signal to itself so the exit status is the signal's", () => {
    const kill = jest.spyOn(process, "kill").mockImplementation((() => true) as never);
    const removed = jest.spyOn(process, "removeAllListeners");
    jest.useFakeTimers();
    const exit = jest.fn();
    reRaise("SIGINT", exit);
    expect(removed).toHaveBeenCalledWith("SIGINT");
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100); // only if the signal somehow did not end the process
    expect(exit).toHaveBeenCalledWith(128 + os.constants.signals.SIGINT);
    kill.mockRestore();
    removed.mockRestore();
  });

  it("falls back to 128+n for other signals too", () => {
    const kill = jest.spyOn(process, "kill").mockImplementation((() => true) as never);
    jest.useFakeTimers();
    const exit = jest.fn();
    reRaise("SIGTERM", exit);
    jest.advanceTimersByTime(100);
    expect(exit).toHaveBeenCalledWith(143);
    kill.mockRestore();
  });
});
