import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import fs from "node:fs";
import { makeFakeRedis } from "./fake-redis.js";

const fake = makeFakeRedis();
fake.connect.mockRejectedValue(new Error("ECONNREFUSED"));
jest.unstable_mockModule("redis", () => ({ createClient: jest.fn(() => fake) }));
process.env.REDIS_URL = "redis://fake:6379";

let L: typeof import("../src/utils/logger.js");

beforeAll(async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  L = await import("../src/utils/logger.js");
});

describe("logger when Redis is unreachable", () => {
  it("warns, then logs to the file instead", async () => {
    await L.startRedis();
    expect(console.warn).toHaveBeenCalledWith("redis unavailable:", "ECONNREFUSED");
    L.reqCtx.run({ session: "chat:x", turn: 1, mode: "game" }, () => L.logModel({ role: "narrator", response: "kept" }));
    await L.flushLogs();
    const lines = fs.readFileSync(process.env.LOG_FILE!, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ session: "chat:x", response: "kept" });
    expect(fake.xAdd).not.toHaveBeenCalled();
  });

  it("closeLogger is safe without a connection", async () => {
    await expect(L.closeLogger()).resolves.toBeUndefined();
  });
});
