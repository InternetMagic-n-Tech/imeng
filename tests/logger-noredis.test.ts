import { describe, it, expect, beforeAll, jest } from "@jest/globals";
import fs from "node:fs";

let L: typeof import("../src/utils/logger.js");

beforeAll(async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  L = await import("../src/utils/logger.js");
});

describe("logger without REDIS_URL", () => {
  it("says so and logs to the file", async () => {
    await L.startRedis();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("REDIS_URL not set"));
    L.reqCtx.run({ session: "chat:n", turn: 1, mode: "game" }, () => L.logModel({ role: "narrator", response: "file only" }));
    await L.flushLogs();
    expect(fs.readFileSync(process.env.LOG_FILE!, "utf8")).toContain("file only");
  });

  it("surfaces a file-write failure as a warning instead of throwing", async () => {
    const real = fs.mkdirSync;
    jest.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("disk full"); });
    L.reqCtx.run({ session: "s", mode: "game", turn: 1 }, () => L.logModel({ role: "narrator", response: "x" }));
    await L.flushLogs();
    expect(console.warn).toHaveBeenCalledWith("could not log model response:", "disk full");
    (fs.mkdirSync as unknown as jest.Mock).mockRestore?.();
    expect(fs.mkdirSync).toBe(real);
  });
});
