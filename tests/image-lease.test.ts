import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
const { Lease, QueueFull } = await import("../src/utils/image-lease.js");

const deps = (max = 1) => { const log: string[] = []; return { log, d: { unload: async () => { log.push("unload"); }, free: async () => { log.push("free"); }, max } }; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GPU lease", () => {
  it("unloads once, runs jobs one at a time, frees when the queue drains", async () => {
    const { log, d } = deps(2);
    const l = new Lease(d);
    const job = (n: string) => async () => { log.push("start " + n); await wait(10); log.push("end " + n); return n; };
    const out = await Promise.all([l.run(job("a")), l.run(job("b")), l.run(job("c"))]);
    expect(out).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["unload", "start a", "end a", "start b", "end b", "start c", "end c", "free"]);
    expect(l.busy).toBe(false);
  });
  it("refuses a job when the queue is full", async () => {
    const { d } = deps(1);
    const l = new Lease(d);
    const a = l.run(() => wait(30));
    const b = l.run(() => wait(1));
    expect(l.waiting).toBe(1);
    await expect(l.run(async () => 1)).rejects.toBeInstanceOf(QueueFull);
    await Promise.all([a, b]);
  });
  it("holds narrator calls at the gate until the last picture is done", async () => {
    const { log, d } = deps();
    const l = new Lease(d);
    await l.gate(); // nothing held: immediate
    const run = l.run(async () => { await wait(30); });
    await wait(5);
    let passed = false;
    const g = l.gate().then(() => { passed = true; log.push("gate"); });
    await wait(10);
    expect(passed).toBe(false);
    await run; await g;
    expect(log).toEqual(["unload", "free", "gate"]);
  });
  it("still frees and lets go when a job fails or the unload fails", async () => {
    const log: string[] = [];
    const l = new Lease({ unload: async () => { throw new Error("ollama down"); }, free: async () => { log.push("free"); }, max: 1 });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(l.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(log).toEqual(["free"]);
    await l.gate();
    expect(await l.run(async () => 5)).toBe(5);
  });
});
