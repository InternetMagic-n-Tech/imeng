import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { realSys } from "../src/utils/doctor-sys.js";

const sys = realSys();
let server: http.Server;
let base: string;
const seen: { method?: string; body: string; type?: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, body, type: req.headers["content-type"] });
      if (req.url === "/json") { res.setHeader("content-type", "application/json"); res.end('{"hello":"world"}'); }
      else if (req.url === "/text") res.end("plain text, not json");
      else if (req.url === "/bad") { res.statusCode = 503; res.end('{"error":"busy"}'); }
      else if (req.url === "/slow") setTimeout(() => res.end("{}"), 2000);
      else res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe("realSys", () => {
  it("describes this machine", () => {
    expect(sys.platform).toBe(process.platform);
    expect(sys.arch).toBe(process.arch);
    expect(sys.nodeVersion).toBe(process.version);
    expect(sys.env).toBe(process.env);
    expect(sys.totalmem()).toBeGreaterThan(0);
    expect(sys.freemem()).toBeGreaterThan(0);
    expect(sys.cpus().length).toBeGreaterThan(0);
  });

  it("exec returns a command's output, or null when it is missing or fails", async () => {
    expect(await sys.exec(process.execPath, ["-e", "process.stdout.write('hi')"])).toBe("hi");
    expect(await sys.exec("definitely-not-a-real-command-xyz", [])).toBeNull();
    expect(await sys.exec(process.execPath, ["-e", "process.exit(3)"])).toBeNull();
  });

  it("exec gives up on a command that takes too long", async () => {
    expect(await sys.exec(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 150)).toBeNull();
  });

  it("http parses JSON, and sends JSON bodies with a content type", async () => {
    const get = await sys.http(`${base}/json`);
    expect(get).toEqual({ ok: true, status: 200, json: { hello: "world" } });
    await sys.http(`${base}/echo`, { method: "POST", body: { a: 1 } });
    expect(seen.at(-1)).toMatchObject({ method: "POST", body: '{"a":1}', type: "application/json" });
  });

  it("http reports non-OK statuses and non-JSON bodies without throwing", async () => {
    expect(await sys.http(`${base}/bad`)).toEqual({ ok: false, status: 503, json: { error: "busy" } });
    const text = await sys.http(`${base}/text`);
    expect(text).toMatchObject({ ok: true, status: 200 });
    expect(text!.json).toBeUndefined();
  });

  it("http returns null when nothing is listening or the request times out", async () => {
    expect(await sys.http("http://127.0.0.1:9/nothing")).toBeNull();
    expect(await sys.http(`${base}/slow`, undefined, 100)).toBeNull();
  });

  it("exists / readFile read the file system and never throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-sys-"));
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "contents");
    expect(sys.exists(f)).toBe(true);
    expect(sys.exists(path.join(dir, "missing"))).toBe(false);
    expect(sys.readFile(f)).toBe("contents");
    expect(sys.readFile(path.join(dir, "missing"))).toBeNull();
  });

  it("portFree is true for a free port and false for one in use", async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, r));
    const port = (busy.address() as net.AddressInfo).port;
    expect(await sys.portFree(port)).toBe(false);
    await new Promise((r) => busy.close(r));
    expect(await sys.portFree(port)).toBe(true);
  });

  it("redisPing reports a connection failure instead of throwing", async () => {
    const r = await sys.redisPing("redis://127.0.0.1:9", 500);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
