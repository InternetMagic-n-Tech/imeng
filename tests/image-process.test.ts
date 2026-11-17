import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";
import { EventEmitter } from "node:events";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
const { expand, plan, ensureRenderer } = await import("../src/utils/image-process.js");

describe("renderer process", () => {
  it("fills ${NAME} from the environment and names the ones that are missing", () => {
    expect(expand("a ${X} b ${Y}", { X: "1", Y: "2" })).toEqual({ text: "a 1 b 2", missing: [] });
    expect(expand("${X}${Z}", { X: "1" }).missing).toEqual(["Z"]);
    const p = plan({ command: "${PY}", args: ["main.py", "--port", "${PORT}"], env: { CUDA_VISIBLE_DEVICES: "${GPU}" }, cwd: "${HOME_DIR}" }, { PY: "/venv/bin/python", PORT: "8188", GPU: "0", HOME_DIR: "/opt/c", KEEP: "k" });
    expect(p).toMatchObject({ command: "/venv/bin/python", args: ["main.py", "--port", "8188"], cwd: "/opt/c" });
    expect(p.env.CUDA_VISIBLE_DEVICES).toBe("0");
    expect(p.env.KEEP).toBe("k");
    expect(() => plan({ command: "${A}", args: ["${B}"] }, {})).toThrow("A, B");
  });
  it("starts nothing when config.json has no process, or the renderer already answers", async () => {
    await expect(ensureRenderer()).resolves.toBeUndefined(); // the fixture has none
  });
});

describe("renderer process start", () => {
  it("spawns detached, waits until the renderer answers, and leaves it running", async () => {
    jest.resetModules();
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP!, "g-"));
    fs.writeFileSync(path.join(dir, "SYSTEM_PROMPT.md"), "x");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ images: { renderer: "comfyui", workflow: "w.json", process: { command: "${PY}", args: ["main.py"], env: { A: "${PORT}" } } } }));
    process.env.IMENG_PATH = dir; process.env.PY = "python3"; process.env.PORT = "8188";
    const m = await import("../src/utils/image-process.js");
    let up = false, n = 0;
    const child = Object.assign(new EventEmitter(), { unref: jest.fn(), kill: jest.fn() });
    const spawnFn = jest.fn((..._a: unknown[]) => child);
    const f = jest.fn(async () => { if (!up && ++n > 2) up = true; if (!up) throw new Error("refused"); return new Response("ok"); });
    await m.ensureRenderer({ fetch: f as unknown as typeof fetch, spawn: spawnFn as never, sleep: async () => {} });
    expect(spawnFn).toHaveBeenCalledWith("python3", ["main.py"], expect.objectContaining({ detached: true, stdio: "ignore" }));
    expect(child.unref).toHaveBeenCalled();
    // already up: no second spawn
    await m.ensureRenderer({ fetch: f as unknown as typeof fetch, spawn: spawnFn as never, sleep: async () => {} });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // never answers: gives up with a clear error
    up = false; n = -1000;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const never = jest.fn(async () => { throw new Error("refused"); });
    await expect(m.ensureRenderer({ fetch: never as unknown as typeof fetch, spawn: spawnFn as never, sleep: async () => {} })).rejects.toThrow("did not start");
    child.emit("error", new Error("ENOENT"));
  });
});

describe("renderer process in production", () => {
  it("never spawns: the renderer must already be running", async () => {
    jest.resetModules();
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP!, "gp-"));
    fs.writeFileSync(path.join(dir, "SYSTEM_PROMPT.md"), "x");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ images: { renderer: "a1111", process: { command: "/bin/true" } } }));
    process.env.IMENG_PATH = dir; process.env.NODE_ENV = "production";
    try {
      const m = await import("../src/utils/image-process.js");
      const spawnFn = jest.fn();
      const down = jest.fn(async () => { throw new Error("refused"); });
      await expect(m.ensureRenderer({ fetch: down as unknown as typeof fetch, spawn: spawnFn as never })).rejects.toThrow("production");
      expect(spawnFn).not.toHaveBeenCalled();
    } finally { delete process.env.NODE_ENV; }
  });
  it("warns which variable is missing when the command cannot be filled in", async () => {
    jest.resetModules();
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP!, "gm-"));
    fs.writeFileSync(path.join(dir, "SYSTEM_PROMPT.md"), "x");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ images: { renderer: "a1111", process: { command: "${NOPE_DIR}/run.sh" } } }));
    process.env.IMENG_PATH = dir;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const m = await import("../src/utils/image-process.js");
    const down = jest.fn(async () => { throw new Error("refused"); });
    await expect(m.ensureRenderer({ fetch: down as unknown as typeof fetch })).rejects.toThrow("NOPE_DIR");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOPE_DIR"));
  });
});

describe("renderer process in a venv", () => {
  it("applies what activate does, runs through the project's spawn helper, and stops the whole group when the app is killed", async () => {
    jest.resetModules();
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP!, "gv-"));
    fs.writeFileSync(path.join(dir, "SYSTEM_PROMPT.md"), "x");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ images: { renderer: "a1111", process: { command: "python", args: ["launch.py", "--api"], cwd: "${VDIR}", venv: "${VDIR}/venv" } } }));
    process.env.IMENG_PATH = dir; process.env.VDIR = "/opt/a1111"; delete process.env.NODE_ENV;
    const m = await import("../src/utils/image-process.js");
    const sh = await import("../src/utils/shutdown.js");
    sh._resetShutdown();
    let up = false;
    const child = Object.assign(new EventEmitter(), { pid: 4242, unref: jest.fn() });
    const tspawn = jest.fn((..._a: unknown[]) => ({ child, promise: Promise.reject(new Error("Exit code is: 1")) }));
    const f = jest.fn(async () => { if (!up) { up = true; throw new Error("refused"); } return new Response("ok"); });
    const killed: number[] = [];
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await m.ensureRenderer({ fetch: f as unknown as typeof fetch, tspawn: tspawn as never, sleep: async () => {}, exists: () => true, killGroup: (pid) => killed.push(pid) });
    const [cmd, args, env, cwd, opts] = tspawn.mock.calls[0] as [string, string[], NodeJS.ProcessEnv, string, { detached: boolean }];
    expect(cmd).toBe("/opt/a1111/venv/bin/python");
    expect(args).toEqual(["launch.py", "--api"]);
    expect(env.VIRTUAL_ENV).toBe("/opt/a1111/venv");
    expect(env.PATH!.startsWith("/opt/a1111/venv/bin:")).toBe(true);
    expect(env.PYTHONHOME).toBeUndefined();
    expect(cwd).toBe("/opt/a1111");
    expect(opts.detached).toBe(true);
    expect(child.unref).not.toHaveBeenCalled(); // tied to this app
    await sh.exitOnSignal("SIGTERM", { keyboard: false, raise: () => {} });
    expect(killed).toEqual([4242]);
  });
  it("says how to make a missing venv", async () => {
    jest.resetModules();
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP!, "gw-"));
    fs.writeFileSync(path.join(dir, "SYSTEM_PROMPT.md"), "x");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ images: { renderer: "a1111", process: { command: "python", venv: "/nope/venv" } } }));
    process.env.IMENG_PATH = dir;
    const m = await import("../src/utils/image-process.js");
    const down = jest.fn(async () => { throw new Error("refused"); });
    await expect(m.ensureRenderer({ fetch: down as unknown as typeof fetch, exists: () => false })).rejects.toThrow("python3 -m venv /nope/venv");
  });
  it("venvEnv: Windows layout, and a non-python command stays as it is", async () => {
    const { venvEnv } = await import("../src/utils/image-plan.js");
    const w = venvEnv("C:\\sd\\venv\\", "python", { PATH: "C:\\x", PYTHONHOME: "h" }, () => true, true);
    expect(w.command).toBe("C:\\sd\\venv\\Scripts\\python.exe");
    expect(w.env.PATH).toBe("C:\\sd\\venv\\Scripts;C:\\x");
    expect(venvEnv("/v", "./webui.sh", {}, () => true, false).command).toBe("./webui.sh");
    expect(venvEnv("/v", "python3", {}, () => false, false).command).toBe("python3");
  });
});
