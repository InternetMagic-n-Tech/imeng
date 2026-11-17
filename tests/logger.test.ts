import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import { makeFakeRedis } from "./fake-redis.js";

const fake = makeFakeRedis();
jest.unstable_mockModule("redis", () => ({ createClient: jest.fn(() => fake) }));
process.env.REDIS_URL = "redis://fake:6379";

let L: typeof import("../src/utils/logger.js");
const inCtx = <T>(ctx: Partial<import("../src/utils/logger.js").RequestContext>, fn: () => T): T =>
  L.reqCtx.run({ session: "", turn: "", mode: "", ...ctx }, fn);
const entryOf = (i: number) => JSON.parse(fake.added[i].fields.entry);
const logFile = () => (fs.existsSync(process.env.LOG_FILE!) ? fs.readFileSync(process.env.LOG_FILE!, "utf8").trim().split("\n").filter(Boolean) : []);

beforeAll(async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  L = await import("../src/utils/logger.js");
  await L.startRedis();
});

beforeEach(() => { fake.added.length = 0; fake.isReady = true; fake.xAdd.mockClear(); });

describe("logger with Redis", () => {
  it("connected and announced the stream", () => {
    expect(fake.connect).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('redis stream "game:model-responses"'));
  });

  it("logs game-mode entries as ONE json field with trimming", async () => {
    inCtx({ session: "chat:1", turn: 2, mode: "game" }, () =>
      L.logModel({ role: "narrator", model: "m", prompt: [{ role: "user", content: "hi" }], response: "hello", ms: 12 }));
    await L.flushLogs();
    expect(fake.added).toHaveLength(1);
    expect(Object.keys(fake.added[0].fields)).toEqual(["entry"]);
    expect(fake.added[0].key).toBe("game:model-responses");
    expect(fake.added[0].opts).toEqual({ TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } });
    expect(entryOf(0)).toMatchObject({ game: "test-game", role: "narrator", model: "m", session: "chat:1", turn: "2", mode: "game", ms: "12", response: "hello", error: "" });
    expect(entryOf(0).prompt).toContain('"content":"hi"');
    expect(new Date(entryOf(0).ts).toString()).not.toBe("Invalid Date");
  });

  it("records errors and tolerates missing optional fields", async () => {
    inCtx({ session: "s", mode: "game" }, () => L.logModel({ role: "judge", error: new Error("boom") }));
    await L.flushLogs();
    expect(entryOf(0)).toMatchObject({ role: "judge", model: "", ms: "", response: "", error: "Error: boom" });
  });

  it("does not log direct-mode, unknown-mode or context-free calls", async () => {
    inCtx({ mode: "direct" }, () => L.logModel({ role: "direct", response: "x" }));
    inCtx({ mode: "" }, () => L.logModel({ role: "x" }));
    L.logModel({ role: "no context" });
    await L.flushLogs();
    expect(fake.added).toHaveLength(0);
  });

  it("truncates huge prompts", async () => {
    inCtx({ mode: "game" }, () => L.logModel({ role: "narrator", prompt: "x".repeat(30000), response: "ok" }));
    await L.flushLogs();
    expect(entryOf(0).prompt).toMatch(/…\[truncated 10000 chars\]$/);
  });

  describe("hold / release", () => {
    it("keeps held entries when released as a game, stamping the final session", async () => {
      await inCtx({ session: "pending", mode: "" }, async () => {
        L.holdLogs();
        L.logModel({ role: "invocation", response: "{}" });
        await L.flushLogs();
        expect(fake.added).toHaveLength(0);
        const c = L.reqCtx.getStore()!;
        c.session = "chat:final"; c.mode = "game";
        L.releaseLogs(true);
      });
      await L.flushLogs();
      expect(fake.added).toHaveLength(1);
      expect(entryOf(0)).toMatchObject({ role: "invocation", session: "chat:final", mode: "game" });
    });

    it("discards held entries when released as direct", async () => {
      await inCtx({ mode: "" }, async () => {
        L.holdLogs();
        L.logModel({ role: "invocation" });
        L.releaseLogs(false);
        L.logModel({ role: "later" }); // mode still unknown, so skipped
      });
      await L.flushLogs();
      expect(fake.added).toHaveLength(0);
    });

    it("is a no-op outside a request or when nothing is held", () => {
      expect(() => { L.holdLogs(); L.releaseLogs(true); }).not.toThrow();
      inCtx({ mode: "game" }, () => expect(() => L.releaseLogs(true)).not.toThrow());
    });
  });

  describe("fallback to the log file", () => {
    it("writes JSONL when Redis rejects the write", async () => {
      fake.xAdd.mockRejectedValueOnce(new Error("down"));
      inCtx({ session: "chat:f", mode: "game" }, () => L.logModel({ role: "narrator", response: "to-file" }));
      await L.flushLogs();
      expect(JSON.parse(logFile().at(-1)!)).toMatchObject({ session: "chat:f", response: "to-file" });
    });

    it("writes JSONL when Redis is not ready", async () => {
      fake.isReady = false;
      inCtx({ session: "chat:g", mode: "game" }, () => L.logModel({ role: "narrator", response: "offline" }));
      await L.flushLogs();
      expect(fake.xAdd).not.toHaveBeenCalled();
      expect(JSON.parse(logFile().at(-1)!).response).toBe("offline");
    });
  });

  it("throttles redis connection-error warnings", () => {
    (console.warn as jest.Mock).mockClear();
    fake.handlers.error(new Error("econnrefused"));
    fake.handlers.error(new Error("econnrefused again"));
    const warns = (console.warn as jest.Mock).mock.calls.filter((c) => c[0] === "redis:");
    expect(warns).toHaveLength(1);
  });

  it("closeLogger flushes and quits", async () => {
    await L.closeLogger();
    expect(fake.quit).toHaveBeenCalled();
  });
});
