import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { createClient } from "redis";
import type { Sys } from "./doctor.js";

/** The real machine, behind the `Sys` interface the doctor's checks use. */
export function realSys(): Sys {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    env: process.env,
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    cpus: () => os.cpus(),

    exec: (cmd, args, timeoutMs = 5000) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
      }),

    http: async (url, init, timeoutMs = 5000) => {
      try {
        const res = await fetch(url, {
          method: init?.method,
          headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        let json: unknown;
        try { json = await res.json(); } catch { /* not JSON */ }
        return { ok: res.ok, status: res.status, json };
      } catch { return null; }
    },

    exists: (p) => fs.existsSync(p),
    readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },

    portFree: (port) =>
      new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => server.close(() => resolve(true)));
        server.listen(port);
      }),

    dbState: async (url) => {
      try {
        const { openDb } = await import("./db.js");
        const { readState } = await import("./db-migrations.js");
        const db = await openDb(url);
        try { return await readState(db, (await import("./db-state.js")).expectedStamp().gameId); } finally { await db.destroy(); }
      } catch (e) { return { error: (e as Error).message }; }
    },

    redisPing: async (url, timeoutMs = 3000) => {
      const client = createClient({ url, socket: { connectTimeout: timeoutMs, reconnectStrategy: false } }) as any;
      client.on("error", () => {});
      try {
        await client.connect();
        await client.ping();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        try { client.destroy?.() ?? client.disconnect?.(); } catch { /* already closed */ }
      }
    },
  };
}
