import { describe, it, expect } from "@jest/globals";
import { runStages } from "../src/utils/pipeline.js";
import { profileFor } from "../src/utils/run-profile.js";
import { pickCompare, parseList } from "../src/utils/compare-models.js";

const fast = { ...profileFor({}), concurrency: 2, retries: 2, backoffMs: 1, backoffMaxMs: 2, taskTimeoutMs: 200 };
const quiet = { profile: fast, log: () => {} };

describe("runStages", () => {
  it("runs arrays and handler maps in turn, passing what then returns on", async () => {
    const out = await runStages([
      { tasks: [async () => 1, async () => 2], handlers: { then: (r: number[]) => r.reduce((a, b) => a + b, 0) } },
      { tasks: [async (n: number) => n * 10], handlers: { then: (r: number[]) => r[0] + 1 } },
    ], undefined, quiet);
    expect(out).toBe(31);
  });
  it("retries a failing task with backoff, then gives up", async () => {
    let n = 0;
    expect(await runStages([{ tasks: [async () => { if (++n < 3) throw new Error("flaky"); return "ok"; }] }], undefined, quiet)).toEqual(["ok"]);
    expect(n).toBe(3);
    let m = 0;
    await expect(runStages([{ tasks: [async () => { m++; throw new Error("down"); }] }], undefined, quiet)).rejects.toThrow("down");
    expect(m).toBe(3);
  });
  it("catch can stand in for a failed stage; finally always runs", async () => {
    const seen: string[] = [];
    const out = await runStages([
      { tasks: [async () => { throw new Error("x"); }], opts: { retries: 0 }, handlers: { catch: (e) => `recovered ${(e as Error).message}`, finally: () => { seen.push("f1"); } } },
      { tasks: [async (v: string) => v + "!"], handlers: { finally: () => { seen.push("f2"); } } },
    ], undefined, quiet);
    expect(out).toEqual(["recovered x!"]);
    expect(seen).toEqual(["f1", "f2"]);
    await expect(runStages([{ tasks: [async () => { throw new Error("y"); }], opts: { retries: 0 }, handlers: { finally: () => { seen.push("f3"); } } }], undefined, quiet)).rejects.toThrow("y");
    expect(seen.at(-1)).toBe("f3");
  });
  it("allSettled keeps every result; race takes the first; series chains", async () => {
    const s = await runStages([{ tasks: [async () => 1, async () => { throw new Error("b"); }], opts: { mode: "allSettled", retries: 0 } }], undefined, quiet) as PromiseSettledResult<number>[];
    expect(s.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const slow = (ms: number, v: string) => () => new Promise<string>((r) => setTimeout(() => r(v), ms));
    expect(await runStages([{ tasks: [slow(60, "slow"), slow(1, "fast")], opts: { mode: "race" } }], undefined, quiet)).toBe("fast");
    expect(await runStages([{ tasks: [async (n: number) => n + 1, async (n: number) => n * 3], opts: { mode: "series" } }], 1, quiet)).toEqual([2, 6]);
  });
  it("limits concurrency and times a task out", async () => {
    let live = 0, peak = 0;
    const t = async () => { peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 10)); live--; };
    await runStages([{ tasks: [t, t, t, t, t], opts: { concurrency: 2 } }], undefined, quiet);
    expect(peak).toBe(2);
    await expect(runStages([{ tasks: [() => new Promise<void>(() => {})], opts: { retries: 0 } }], undefined, { ...quiet, profile: { ...fast, taskTimeoutMs: 20 } })).rejects.toThrow(/timed out/);
  });
  it("logs under its own names and the console by default", async () => {
    const lines: string[] = [];
    await runStages([{ name: "warm", tasks: [async () => 1] }], undefined, { profile: fast, log: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/^warm: done in \d+ms$/);
    await runStages([{ tasks: [async () => 1] }], undefined, { profile: fast }); // default console.log (silent under jest)
  });
});

describe("profileFor", () => {
  it("is gentle outside production, high in production, env tunes it and a flag wins", () => {
    expect(profileFor({}).name).toBe("low");
    expect(profileFor({}).concurrency).toBe(1);
    expect(profileFor({ NODE_ENV: "production" }).concurrency).toBe(8);
    expect(profileFor({ DRIVER_CONCURRENCY: "3", DRIVER_RETRIES: "0" }).concurrency).toBe(3);
    expect(profileFor({ DRIVER_CONCURRENCY: "3" }, { concurrency: 5 }).concurrency).toBe(5);
    expect(profileFor({ DRIVER_CONCURRENCY: "abc" }).concurrency).toBe(1);
  });
});

describe("compare models", () => {
  it("reads an array or a comma list", () => {
    expect(parseList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(parseList("[a,b")).toEqual(["[a", "b"]);
    expect(parseList(undefined)).toEqual([]);
  });
  it("runs all unless one is preferred; a bad preference runs all and says so; flags beat env", () => {
    const env = { COMPARE_MODELS: "a,b,c" };
    expect(pickCompare({ env })).toEqual({ models: ["a", "b", "c"], forced: false });
    expect(pickCompare({ env: { ...env, COMPARE_PREFER: "2" } })).toEqual({ models: ["b"], forced: true });
    expect(pickCompare({ env, prefer: 9 }).note).toMatch(/not one of the 3/);
    expect(pickCompare({ env, list: ["x", "y"], prefer: "1" }).models).toEqual(["x"]);
  });
});
