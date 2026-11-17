import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import fs from "node:fs";
import { makeFakeRedis } from "./fake-redis.js";

const fake = makeFakeRedis();
jest.unstable_mockModule("redis", () => ({ createClient: jest.fn(() => fake) }));
jest.unstable_mockModule("../src/utils/cli.js", () => ({ PERSIST: false, parseArgs: () => ({ persist: false }) }));
process.env.REDIS_URL = "redis://fake:6379";

let L: typeof import("../src/utils/logger.js");
const log = (session: string, response: string) =>
  L.reqCtx.run({ session, turn: 1, mode: "game" }, () => L.logModel({ role: "narrator", response }));

beforeAll(async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  L = await import("../src/utils/logger.js");
  await L.startRedis();
});

describe("logger with --no-persist", () => {
  it("announces the purge", () => {
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("will be purged on exit"));
  });

  it("purges exactly the entries this process wrote, grouped by session", async () => {
    log("chat:a", "1"); log("chat:a", "2"); log("chat:b", "3");
    await L.flushLogs();
    expect(fake.added).toHaveLength(3);

    await L.closeLogger();
    expect(fake.xDel).toHaveBeenCalledTimes(1);
    const [key, ids] = fake.xDel.mock.calls[0] as [string, string[]];
    expect(key).toBe("game:model-responses");
    expect(ids.sort()).toEqual(["1001-0", "1002-0", "1003-0"]);
    expect(console.log).toHaveBeenCalledWith("--no-persist: removed 3 Redis log entries from 2 session(s)");
    expect(console.log).toHaveBeenCalledWith("  - chat:a");
    expect(console.log).toHaveBeenCalledWith("  - chat:b");
    expect(fake.quit).toHaveBeenCalled();
  });

  it("purging again with nothing written deletes nothing", async () => {
    fake.xDel.mockClear();
    fake.isOpen = true;
    await L.closeLogger();
    expect(fake.xDel).not.toHaveBeenCalled();
  });

  it("deletes in batches of 500", async () => {
    fake.xDel.mockClear();
    for (let i = 0; i < 1200; i++) log("chat:big", String(i));
    await L.flushLogs();
    fake.isOpen = true;
    await L.closeLogger();
    expect(fake.xDel.mock.calls.map((c) => (c[1] as string[]).length)).toEqual([500, 500, 200]);
  });

  it("drops entries (no file) when Redis fails", async () => {
    fake.xAdd.mockRejectedValueOnce(new Error("down"));
    log("chat:lost", "gone");
    await L.flushLogs();
    expect(fs.existsSync(process.env.LOG_FILE!)).toBe(false);
  });
});
