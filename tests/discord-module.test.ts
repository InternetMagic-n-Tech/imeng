import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import { createDiscordModule, bridgeCommand, MISSING } from "../src/modules/discord/index.js";
import type { BridgeDeps } from "../src/modules/discord/index.js";
import { REGISTRY, startInterfaces, stopInterfaces } from "../src/modules/index.js";

const deps = (over: Partial<BridgeDeps> = {}) => {
  const log: string[] = []; const killed: string[] = []; const launched: { cmd: string; args: string[] }[] = [];
  let up = false, probes = 0;
  const d: BridgeDeps = {
    address: async () => ({ host: "127.0.0.1", port: 3030 }),
    probe: async () => { probes++; return up; },
    launch: (cmd, args) => { launched.push({ cmd, args }); return { kill: () => { killed.push("killed"); } }; },
    exists: () => false, sleep: async () => { if (launched.length && probes > 2) up = true; }, production: false, cwd: "/repo", log: (l) => { log.push(l); },
    ...over,
  };
  return { d, log, killed, launched, setUp: (v: boolean) => { up = v; } };
};

describe("bridgeCommand", () => {
  it("runs the built bridge when there is one, else the source through vite-node", () => {
    expect(bridgeCommand("/repo", (f) => f === "/repo/dist/discord-bridge.js")).toEqual({ cmd: process.execPath, args: ["/repo/dist/discord-bridge.js"] });
    expect(bridgeCommand("/repo", () => false).args).toEqual(["/repo/node_modules/vite-node/dist/cli.mjs", "/repo/scripts/discord-bridge.ts"]);
  });
});

describe("the Discord interface module", () => {
  it("does nothing when the bridge already answers", async () => {
    const t = deps(); t.setUp(true);
    await createDiscordModule(t.d).start({ app: express() });
    expect(t.launched).toEqual([]);
    expect(t.log[0]).toContain("already running");
  });

  it("outside production, starts the bridge when nothing answers, waits until it does, and stops it with the proxy", async () => {
    const t = deps({ exists: (f) => f.endsWith("dist/discord-bridge.js") });
    const mod = createDiscordModule(t.d);
    await mod.start({ app: express() });
    expect(t.launched).toHaveLength(1); // start returns at once: the proxy is not held up
    expect(t.log.at(-1)).not.toContain("the bridge is up");
    await mod.settled();
    expect(t.launched[0].args[0]).toBe("/repo/dist/discord-bridge.js");
    expect(t.log.some((l) => l.includes("nothing answers"))).toBe(true);
    expect(t.log.at(-1)).toContain("the bridge is up");
    await mod.stop?.();
    expect(t.killed).toEqual(["killed"]);
    await mod.stop?.(); // twice is fine
    expect(t.killed).toHaveLength(1);
  });

  it("in production it never starts anything: the bridge is assumed to be running, with a warning when it does not answer", async () => {
    const t = deps({ production: true });
    await createDiscordModule(t.d).start({ app: express() });
    expect(t.launched).toEqual([]);
    expect(t.log[0]).toContain("production: the bridge is expected at http://127.0.0.1:3030/healthz but does not answer");
  });

  it("says so when a started bridge never answers", async () => {
    const t = deps({ sleep: async () => {} });
    const mod = createDiscordModule(t.d);
    await mod.start({ app: express() });
    await mod.settled();
    expect(t.log.at(-1)).toContain("did not answer within 18 s");
  });

  it("is registered, and starting it logs once what it lacks compared with Open WebUI", async () => {
    expect(Object.keys(REGISTRY)).toEqual(expect.arrayContaining(["openwebui", "discord"]));
    const t = deps(); t.setUp(true);
    const lines: string[] = []; jest.spyOn(console, "log").mockImplementation((l: string) => { lines.push(String(l)); });
    const original = REGISTRY.discord;
    REGISTRY.discord = async () => ({ default: createDiscordModule(t.d) });
    await startInterfaces(express(), ["discord"]);
    REGISTRY.discord = original;
    await stopInterfaces();
    const missing = lines.filter((l) => l.startsWith("[interface discord] missing feature:"));
    expect(missing).toHaveLength(MISSING.length);
    expect(missing[0]).toContain("regenerate");
    expect(missing.some((l) => l.includes("word-by-word streaming"))).toBe(true);
    jest.restoreAllMocks();
  });
});
