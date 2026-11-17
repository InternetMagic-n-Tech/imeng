import { describe, it, expect, jest } from "@jest/globals";
import { Writable } from "node:stream";
import { silentSpawn, transparentSpawn, muteTSpawn } from "../src/utils/spawn-helper.cjs";

// The helper (utils/spawn-helper.cjs) is used as-is; these tests run real child processes.
const collect = () => {
  const chunks: string[] = [];
  const w = new Writable({ write: (c, _e, cb) => { chunks.push(String(c)); cb(); } });
  return { w, chunks };
};

describe("spawn-helper", () => {
  it("silentSpawn resolves when the process exits cleanly and can capture output", async () => {
    const out = collect();
    const { promise, child } = silentSpawn("node", ["-e", "console.log('hello')"], undefined, undefined, {},
      { log: () => null, stdout: out.w, stderr: out.w });
    await expect(promise).resolves.toEqual({ exec: "node", spawnParms: ["-e", "console.log('hello')"] });
    expect(child.pid).toBeGreaterThan(0);
    expect(out.chunks.join("")).toContain("hello");
  });

  it("rejects on a non-zero exit code", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const out = collect();
    const { promise } = transparentSpawn("node", ["-e", "process.exit(3)"], undefined, undefined, {}, { stdout: out.w, stderr: out.w });
    await expect(promise).rejects.toThrow("Exit code is: 3");
  });

  it("resolves when the child is killed by a signal", async () => {
    const out = collect();
    const { promise, child } = silentSpawn("node", ["-e", "setInterval(()=>{},1000)"], undefined, undefined, {},
      { log: () => null, stdout: out.w, stderr: out.w });
    child.kill("SIGTERM");
    await expect(promise).resolves.toBeDefined();
  });

  it("muteTSpawn swallows stdout but keeps stderr", () => {
    const io = muteTSpawn();
    expect(io.stdout).toBeDefined();
    expect(io.stderr).toBe(process.stderr);
  });
});
