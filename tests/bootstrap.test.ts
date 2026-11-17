import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import net from "node:net";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { bootstrap, preflight } from "../src/utils/bootstrap.js";
import { app } from "../src/app.js";
import { makeSettings, makeSys } from "./fake-sys.js";
import { GiB } from "../src/utils/doctor.js";
import fs from "node:fs";
import path from "node:path";
import { sessions } from "../src/utils/sessions.js";
import { GAME_SCHEMA_VERSION } from "../src/utils/config.js";

let log: jest.SpiedFunction<typeof console.log>;
let error: jest.SpiedFunction<typeof console.error>;
const logged = () => log.mock.calls.map((c) => String(c[0])).join("\n");

beforeEach(() => {
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  error = jest.spyOn(console, "error").mockImplementation(() => {});
  log.mockClear(); error.mockClear();
});

describe("preflight", () => {
  it("passes quietly when everything is fine", async () => {
    expect(await preflight(makeSys(), makeSettings())).toBe(true);
    expect(logged()).toMatch(/Preflight: all \d+ checks passed/);
    expect(error).not.toHaveBeenCalled();
  });

  it("shows warnings but still allows the start", async () => {
    const ok = await preflight(makeSys({ ramTotal: 8 * GiB }), makeSettings());
    expect(ok).toBe(true);
    expect(logged()).toContain("small for local models");
    expect(error).not.toHaveBeenCalled();
  });

  it("refuses to start on a failure and says so", async () => {
    const ok = await preflight(makeSys({ nodeVersion: "v18.0.0" }), makeSettings());
    expect(ok).toBe(false);
    expect(logged()).toContain("outside the supported range");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Refusing to start"));
  });

  it("can be told to ignore a finding", async () => {
    expect(await preflight(makeSys({ nodeVersion: "v18.0.0" }), makeSettings(), ["node-version"])).toBe(true);
  });

  it("does not print routine findings, only problems", async () => {
    await preflight(makeSys({ ramTotal: 8 * GiB }), makeSettings());
    expect(logged()).not.toContain("is installed");
  });
});

describe("bootstrap", () => {
  it("starts listening (on any free port) and reports where", async () => {
    const server = await bootstrap({ preflight: false, port: 0 });
    expect(server).not.toBeNull();
    expect((server!.address() as AddressInfo).port).toBeGreaterThan(0);
    expect(logged()).toContain("Game proxy on :");
    await new Promise((r) => server!.close(r));
  });

  it("listens on localhost by default and on PROXY_BIND when set", async () => {
    const { listenHost } = await import("../src/utils/bootstrap.js");
    const was = process.env.PROXY_BIND;
    delete process.env.PROXY_BIND;
    expect(listenHost()).toBe("127.0.0.1");
    process.env.PROXY_BIND = "172.17.0.1";
    expect(listenHost()).toBe("172.17.0.1");
    if (was === undefined) delete process.env.PROXY_BIND; else process.env.PROXY_BIND = was;
    const server = await bootstrap({ preflight: false, port: 0 });
    expect((server!.address() as AddressInfo).address).toBe("127.0.0.1");
    await new Promise((r) => server!.close(r));
  });

  it("with preflight on, starts when the checks pass", async () => {
    const server = await bootstrap({ preflight: true, port: 0, sys: makeSys(), settings: makeSettings() });
    expect(server).not.toBeNull();
    expect(logged()).toContain("Preflight");
    await new Promise((r) => server!.close(r));
  });

  it("with preflight on, returns null (starting nothing) when a check fails", async () => {
    const listen = jest.spyOn(app, "listen");
    listen.mockClear();
    const server = await bootstrap({ preflight: true, port: 0, sys: makeSys({ nodeVersion: "v18.0.0" }), settings: makeSettings() });
    expect(server).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });

  it("preflight honours ignore ids", async () => {
    const server = await bootstrap({ preflight: true, port: 0, ignore: ["node-version"], sys: makeSys({ nodeVersion: "v18.0.0" }), settings: makeSettings() });
    expect(server).not.toBeNull();
    await new Promise((r) => server!.close(r));
  });

  it("explains a port that is already taken instead of crashing", async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, r));
    const port = (taken.address() as AddressInfo).port;
    expect(await bootstrap({ preflight: false, port })).toBeNull();
    expect(error).toHaveBeenCalledWith(`Port ${port} is already in use. Stop the other process or set PORT.`);
    await new Promise((r) => taken.close(r));
  });

  it("reports any other listen error", async () => {
    const fake = Object.assign(new EventEmitter(), {});
    const listen = jest.spyOn(app, "listen").mockImplementation((() => { setImmediate(() => fake.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }))); return fake; }) as never);
    expect(await bootstrap({ preflight: false, port: 80 })).toBeNull();
    expect(error).toHaveBeenCalledWith("Could not listen on port 80: denied");
    listen.mockRestore();
  });
});

describe("stored sessions from another schema_version", () => {
  it("refuses to start, names the fix, and does not listen", async () => {
    const dir = process.env.SAVE_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "stale.json");
    fs.writeFileSync(f, JSON.stringify({ key: "chat:stale", schema_version: GAME_SCHEMA_VERSION + 1, snapshots: [{ game: {}, actors: {} }] }));
    try {
      expect(await bootstrap({ preflight: false, port: 0 })).toBeNull();
      expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/Refusing to start.*SESSION_SCHEMA=warn/s);
    } finally { fs.rmSync(f, { force: true }); sessions.clear(); }
  });
});
