import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import debug from "debug";

const { dbg, NAMESPACES } = await import("../src/utils/debug.js");

describe("debug output", () => {
  let out: string[];
  beforeEach(() => { out = []; jest.spyOn(process.stderr, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never); debug.enable("proxy:*"); });
  afterEach(() => { debug.disable(); jest.restoreAllMocks(); });

  it("is silent unless a namespace is enabled", () => {
    debug.disable();
    dbg("engine")("hello");
    expect(out).toEqual([]);
  });

  it("writes under proxy:<name>", () => {
    dbg("phases")("moved %s", "a -> b");
    expect(out.join("")).toContain("proxy:phases");
    expect(out.join("")).toContain("moved a -> b");
  });

  it("removes personal details before anything is written, whatever the game's own filter says", () => {
    dbg("engine")("message from bea@example.com, card 4111 1111 1111 1111, password=hunter2hunter2");
    const text = out.join("");
    expect(text).not.toContain("bea@example.com");
    expect(text).not.toContain("4111");
    expect(text).not.toContain("hunter2");
    expect(text).toMatch(/\[email:[0-9a-f]{6}\]/);
  });

  it("has the namespaces the README lists", () => {
    expect(NAMESPACES).toEqual(["boot", "process", "http", "engine", "phases", "crossings", "pii", "db", "rehydrate", "owner", "judge", "upstream", "redis", "session", "bucket"]);
  });
});

describe("crash trail", () => {
  it("starts once and logs the process line", async () => {
    const out: string[] = [];
    jest.spyOn(process.stderr, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    debug.enable("proxy:process");
    const { startCrashTrail } = await import("../src/utils/crash-trail.js");
    startCrashTrail(); startCrashTrail();
    expect(out.filter((l) => l.includes("start pid"))).toHaveLength(1);
    debug.disable(); jest.restoreAllMocks();
  });
});
