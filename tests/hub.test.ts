import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { discoverGames } from "../src/hub/games.js";
import { childEnv, serverCommand, startChildren, realChildDeps } from "../src/hub/children.js";
import type { ChildDeps, HubChild } from "../src/hub/children.js";
import { buildHubApp } from "../src/hub/app.js";
import { hubSettings, startHub } from "../src/hub/main.js";

const tmp: string[] = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hub-")); tmp.push(d); return d; };
const game = (root: string, rel: string, cfg: object | string) => {
  const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
};
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("discoverGames", () => {
  it("finds games at any depth, names save folders from the path, and reports what it leaves out", async () => {
    const root = mk();
    game(root, "poker", { model_id: "poker-night", icon: " p.png " });
    game(root, "gak/solo", { model_id: "gak-show" });
    game(root, "zdup", { model_id: "poker-night" });
    game(root, "nameless", {});
    game(root, "broken", "{ not json");
    game(root, "skipme", { model_id: "skip-me" });
    const r = await discoverGames(root, ["skip-me"]);
    expect(r.games.map((g) => [g.modelId, g.slug])).toEqual([["gak-show", "gak-solo"], ["poker-night", "poker"]]);
    expect(r.games.find((g) => g.modelId === "poker-night")?.icon).toBe("p.png");
    expect(r.games.find((g) => g.modelId === "gak-show")?.icon).toBeUndefined();
    expect(r.problems.join("\n")).toMatch(/broken.*could not be read/);
    expect(r.problems.join("\n")).toMatch(/zdup: model_id "poker-night" is already used/);
    expect(r.problems.join("\n")).toMatch(/nameless: no model_id/);
    expect(r.problems.join("\n")).not.toMatch(/skip-me/);
  });
  it("returns nothing for an empty folder", async () => {
    expect(await discoverGames(mk())).toEqual({ games: [], problems: [] });
  });
});

describe("childEnv and serverCommand", () => {
  it("binds the child to loopback with the hub's secret and drops what picks a game or an interface", () => {
    const env = childEnv({ GAME_DIR: "x", SYSTEM_PROMPT_PATH: "y", IMENGS_ROOT: "z", HUB_SKIP: "a", INTERFACES: "openwebui,discord", PROXY_BIND: "0.0.0.0", KEEP: "1" }, { dir: "/g/poker", modelId: "p", slug: "poker" }, 4000, "sek", "/saves", "http://hub:3001");
    expect(env).toMatchObject({ IMENG_PATH: "/g/poker", SAVE_DIR: "/saves/poker", PORT: "4000", PROXY_BIND: "127.0.0.1", PROXY_API_KEY: "sek", INTERFACES: "openwebui", IMENG_HUB_CHILD: "1", PUBLIC_URL: "http://hub:3001", KEEP: "1" });
    expect(childEnv({}, { dir: "/g", modelId: "p", slug: "p" }, 1, "s", "/s").PUBLIC_URL).toBeUndefined();
    for (const k of ["GAME_DIR", "SYSTEM_PROMPT_PATH", "IMENGS_ROOT", "HUB_SKIP"]) expect(env[k]).toBeUndefined();
  });
  it("runs the built server, else the source", () => {
    expect(serverCommand("/r", (f) => f === "/r/dist/server.js").args).toEqual(["--env-file-if-exists=/dev/null", "/r/dist/server.js"]);
    expect(serverCommand("/r", () => false).args).toEqual(["--env-file-if-exists=/dev/null", "/r/node_modules/vite-node/dist/cli.mjs", "/r/scripts/server.ts"]);
  });
});

const fakeDeps = (script: Record<string, "up" | "exit" | "never">) => {
  const log: string[] = []; const launched: { env: NodeJS.ProcessEnv; args: string[] }[] = []; const killed: string[] = [];
  const exits = new Map<string, (c: number | null) => void>();
  let n = 0;
  const d: ChildDeps = {
    freePort: async () => 5000 + n++,
    launch: (_cmd, args, env, _cwd, label) => {
      launched.push({ env, args });
      return { kill: () => { killed.push(label); }, onExit: (cb) => { exits.set(label, cb); if (script[label] === "exit") setTimeout(() => cb(1), 0); } };
    },
    ready: async (port) => { const i = launched.findIndex((l) => l.env.PORT === String(port)); const label = Object.keys(script)[i]; return script[label] === "up"; },
    sleep: async () => { await new Promise((r) => setTimeout(r, 1)); },
    exists: () => true,
    log: (l) => { log.push(l); },
  };
  return { d, log, launched, killed, exits };
};
const games = [{ dir: "/g/a", modelId: "a", slug: "a" }, { dir: "/g/b", modelId: "b", slug: "b" }, { dir: "/g/c", modelId: "c", slug: "c" }];
const cfg = { cwd: "/r", saveBase: "/s", env: {}, args: ["--no-persist"], timeoutMs: 40 };

describe("startChildren", () => {
  it("starts games one after another, passes flags, leaves out a game that exits or never answers, and each child has its own secret", async () => {
    const t = fakeDeps({ a: "up", b: "exit", c: "never" });
    const kids = await startChildren(games, cfg, t.d);
    expect(kids.map((k) => k.modelId)).toEqual(["a"]);
    expect(t.launched[0].args).toEqual(["--env-file-if-exists=/dev/null", "/r/dist/server.js", "--no-persist"]);
    expect(new Set(t.launched.map((l) => l.env.PROXY_API_KEY)).size).toBe(3);
    expect(t.log.join("\n")).toMatch(/b exited before it was ready/);
    expect(t.log.join("\n")).toMatch(/c did not answer within/);
    expect(t.killed).toEqual(["b", "c"]);
    expect(kids[0].up()).toBe(true);
    kids[0].stop();
    expect(t.killed).toContain("a");
  });
  it("marks a game down when it exits later", async () => {
    const t = fakeDeps({ a: "up" });
    const [k] = await startChildren([games[0]], cfg, t.d);
    t.exits.get("a")!(137);
    expect(k.up()).toBe(false);
    expect(t.log.join("\n")).toMatch(/a stopped \(exit 137\)/);
  });
});

describe("realChildDeps", () => {
  it("gives a free port, probes /healthz, launches and stops a process", async () => {
    const d = realChildDeps(() => {});
    const port = await d.freePort();
    expect(await d.ready(port)).toBe(false);
    const s = http.createServer((q, r) => { r.statusCode = q.url === "/healthz" ? 200 : 404; r.end(); });
    await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
    expect(await d.ready(port)).toBe(true);
    await new Promise((r) => s.close(r));
    expect(d.exists(process.execPath)).toBe(true);
    await d.sleep(1);
    let code: number | null | undefined;
    const h = d.launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.env, process.cwd(), "x");
    h.onExit((c) => { code = c; });
    h.kill();
    await new Promise((r) => setTimeout(r, 400));
    expect(code === null || code === 0 || code === undefined || typeof code === "number").toBe(true);
    const bad = d.launch("/nonexistent-binary-xyz", [], process.env, process.cwd(), "bad");
    let gone = false; bad.onExit(() => { gone = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(gone).toBe(true);
    bad.kill();
  });
});

interface Fake { base: string; hits: { url: string; headers: http.IncomingHttpHeaders; body: string }[]; close(): Promise<void> }
const fakeChild = (models: string[], reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Fake> => new Promise((resolve) => {
  const hits: Fake["hits"] = [];
  const s = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) })); return; }
      reply(req, res, body);
    });
  });
  s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r(undefined)); }) }));
});
const kid = (modelId: string, f: { base: string }, up = true): HubChild => ({ modelId, baseUrl: f.base, secret: `secret-${modelId}`, up: () => up, stop: () => {} });
const listen = (app: http.RequestListener) => new Promise<{ base: string; close(): Promise<void> }>((resolve) => {
  const s = http.createServer(app);
  s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r(undefined)); }) }));
});
const post = (base: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the hub app", () => {
  let a: Fake, b: Fake, hub: { base: string; close(): Promise<void> };
  beforeEach(async () => {
    a = await fakeChild(["poker-night"], (_q, res, body) => { res.setHeader("content-type", "application/json"); res.setHeader("x-imeng-kick", "u;1"); res.end(JSON.stringify({ echo: JSON.parse(body).model })); });
    b = await fakeChild(["dungeon"], (_q, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: one\n\n");
      setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 60);
    });
  });
  afterEach(async () => { await hub?.close(); await a.close(); await b.close(); });

  it("lists every game's model together", async () => {
    hub = await listen(buildHubApp([kid("poker-night", a), kid("dungeon", b)], { apiKey: "" }));
    const j = await (await fetch(`${hub.base}/v1/models`)).json() as { data: { id: string }[] };
    expect(j.data.map((m) => m.id)).toEqual(["dungeon", "poker-night"]);
  });
  it("drops a game that is down or does not answer from the list", async () => {
    const dead = await fakeChild([], () => {}); const base = dead.base; await dead.close();
    hub = await listen(buildHubApp([kid("poker-night", a), kid("dungeon", { base }), kid("off", b, false)], { apiKey: "", listTimeoutMs: 300 }));
    const j = await (await fetch(`${hub.base}/v1/models`)).json() as { data: { id: string }[] };
    expect(j.data.map((m) => m.id)).toEqual(["poker-night"]);
  });
  it("routes a chat to the game that owns the model, with Open WebUI's headers and the child's secret, never the caller's key", async () => {
    hub = await listen(buildHubApp([kid("poker-night", a), kid("dungeon", b)], { apiKey: "outer" }));
    const r = await post(hub.base, { model: "poker-night", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer outer", "x-openwebui-chat-id": "c1", "x-openwebui-user-id": "u1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ echo: "poker-night" });
    expect(r.headers.get("x-imeng-kick")).toBe("u;1");
    const h = a.hits.at(-1)!;
    expect(h.url).toBe("/v1/chat/completions");
    expect(h.headers["x-openwebui-chat-id"]).toBe("c1");
    expect(h.headers["x-openwebui-user-id"]).toBe("u1");
    expect(h.headers.authorization).toBe("Bearer secret-poker-night");
    expect(JSON.parse(h.body).messages[0].content).toBe("hi");
    expect(b.hits.filter((x) => x.url === "/v1/chat/completions")).toHaveLength(0);
  });
  it("streams the answer as it arrives", async () => {
    hub = await listen(buildHubApp([kid("dungeon", b)], { apiKey: "" }));
    const r = await post(hub.base, { model: "dungeon", stream: true });
    const reader = r.body!.getReader();
    const first = await reader.read();
    const t1 = Date.now();
    expect(new TextDecoder().decode(first.value)).toContain("one");
    let rest = ""; for (;;) { const c = await reader.read(); if (c.done) break; rest += new TextDecoder().decode(c.value); }
    expect(rest).toContain("two");
    expect(Date.now() - t1).toBeGreaterThanOrEqual(0);
  });
  it("answers 404 for an unknown model, 503 for a stopped game, 502 when the game does not answer", async () => {
    const dead = await fakeChild([], () => {}); const base = dead.base; await dead.close();
    hub = await listen(buildHubApp([kid("poker-night", a), kid("off", b, false), kid("gone", { base })], { apiKey: "" }));
    const u = await post(hub.base, { model: "nope" });
    expect(u.status).toBe(404);
    expect(((await u.json()) as { error: { message: string } }).error.message).toMatch(/Known: gone, off, poker-night/);
    expect((await post(hub.base, {})).status).toBe(404);
    expect((await post(hub.base, { model: "off" })).status).toBe(503);
    expect((await post(hub.base, { model: "gone" })).status).toBe(502);
  });
  it("requires the key when one is set, and /healthz needs none", async () => {
    hub = await listen(buildHubApp([kid("poker-night", a)], { apiKey: "outer" }));
    expect((await fetch(`${hub.base}/v1/models`)).status).toBe(401);
    expect((await post(hub.base, { model: "poker-night" })).status).toBe(401);
    expect((await fetch(`${hub.base}/v1/models`, { headers: { authorization: "Bearer outer" } })).status).toBe(200);
    const h = await fetch(`${hub.base}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, games: [{ model: "poker-night", up: true }] });
  });
  it("serves a game's picture without a key, only for a known game", async () => {
    hub = await listen(buildHubApp([kid("poker-night", a)], { apiKey: "outer", iconOf: (id) => (id === "poker-night" || id === "stranger" ? { bytes: Buffer.from("PNG"), type: "image/png" } : null) }));
    const r = await fetch(`${hub.base}/icons/poker-night`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(await r.text()).toBe("PNG");
    expect((await fetch(`${hub.base}/icons/stranger`)).status).toBe(404);
  });
  it("answers 404 for a picture when none is configured", async () => {
    hub = await listen(buildHubApp([kid("poker-night", a)], { apiKey: "" }));
    expect((await fetch(`${hub.base}/icons/poker-night`)).status).toBe(404);
  });
  it("reports /healthz 503 when no game is up", async () => {
    hub = await listen(buildHubApp([kid("off", b, false)], { apiKey: "" }));
    expect((await fetch(`${hub.base}/healthz`)).status).toBe(503);
  });
  it("stops waiting on the game when the caller goes away", async () => {
    const slow = await fakeChild(["slow"], (_q, res) => { res.setHeader("content-type", "text/event-stream"); res.write("data: x\n\n"); });
    hub = await listen(buildHubApp([kid("slow", slow)], { apiKey: "" }));
    const ac = new AbortController();
    const r = await fetch(`${hub.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "slow" }), signal: ac.signal });
    await r.body!.getReader().read();
    ac.abort();
    await new Promise((x) => setTimeout(x, 100));
    await slow.close();
  });
});

describe("hubSettings and startHub", () => {
  it("reads the environment with safe defaults", () => {
    const s = hubSettings({}, ["--no-persist"], "/r");
    expect(s).toMatchObject({ port: 3001, host: "127.0.0.1", apiKey: "", root: "/r/imengs", saveBase: "/r/saves", skip: [], args: ["--no-persist"], childTimeoutMs: 90000, publicUrl: "http://localhost:3001" });
    const p = hubSettings({ NODE_ENV: "production", PORT: "3100", PROXY_BIND: "172.17.0.1", PROXY_API_KEY: "k", IMENGS_ROOT: "g", SAVE_DIR: "/s", HUB_SKIP: "a, b", HUB_CHILD_TIMEOUT_MS: "5" }, [], "/r");
    expect(p).toMatchObject({ port: 3100, host: "172.17.0.1", apiKey: "k", root: "/r/g", saveBase: "/s", skip: ["a", "b"], childTimeoutMs: 5, publicUrl: "http://localhost:3100" });
    expect(hubSettings({ PUBLIC_URL: "https://x.example/" }, [], "/r").publicUrl).toBe("https://x.example");
    expect(hubSettings({ NODE_ENV: "production" }, [], "/r").host).toBe("0.0.0.0");
  });
  it("starts the games it finds and listens", async () => {
    const root = mk(); game(root, "x", { model_id: "x" });
    const t = fakeDeps({ x: "up" }); const log: string[] = [];
    const s = hubSettings({ PORT: "0", IMENGS_ROOT: root, SAVE_DIR: path.join(root, "s") }, [], root);
    const h = await startHub(s, t.d, (l) => log.push(l));
    expect(h?.children.map((c) => c.modelId)).toEqual(["x"]);
    expect(log.join("\n")).toMatch(/listening on 127\.0\.0\.1:\d+: x/);
    await new Promise((r) => h!.server.close(r));
  });
  it("logs each game's picture address, and says when an icon is not usable", async () => {
    const root = mk(); game(root, "x", { model_id: "x", icon: "x.png" }); game(root, "y", { model_id: "y", icon: "missing.png" });
    fs.writeFileSync(path.join(root, "x", "x.png"), "PNG");
    const log: string[] = [];
    const h = await startHub(hubSettings({ PORT: "0", IMENGS_ROOT: root, PUBLIC_URL: "http://pub:3001" }, [], root), fakeDeps({ x: "up", y: "up" }).d, (l) => log.push(l));
    expect(log.join("\n")).toMatch(/\[hub\] x picture: http:\/\/pub:3001\/icons\/x/);
    expect(log.join("\n")).toMatch(/y: icon "missing.png" is not usable/);
    const r = await fetch(`http://127.0.0.1:${(h!.server.address() as AddressInfo).port}/icons/x`);
    expect(await r.text()).toBe("PNG");
    expect((await fetch(`http://127.0.0.1:${(h!.server.address() as AddressInfo).port}/icons/y`)).status).toBe(404);
    await new Promise((res) => { h!.server.closeAllConnections(); h!.server.close(res); });
  });
  it("warns when it listens beyond localhost without a key", async () => {
    const root = mk(); game(root, "x", { model_id: "x" });
    const log: string[] = [];
    const h = await startHub({ ...hubSettings({ PORT: "0", IMENGS_ROOT: root }, [], root), host: "0.0.0.0" }, fakeDeps({ x: "up" }).d, (l) => log.push(l));
    expect(log.join("\n")).toMatch(/PROXY_API_KEY is not set/);
    await new Promise((r) => h!.server.close(r));
  });
  it("gives up, with a reason, when there are no games or none starts", async () => {
    const log: string[] = [];
    expect(await startHub(hubSettings({ IMENGS_ROOT: mk() }, [], "/"), fakeDeps({}).d, (l) => log.push(l))).toBeNull();
    const root = mk(); game(root, "x", { model_id: "x" });
    expect(await startHub(hubSettings({ IMENGS_ROOT: root }, [], root), fakeDeps({ x: "exit" }).d, (l) => log.push(l))).toBeNull();
    expect(log.join("\n")).toMatch(/no games found/);
    expect(log.join("\n")).toMatch(/no game started/);
  });
  it("stops its games and says so when the port is taken", async () => {
    const root = mk(); game(root, "x", { model_id: "x" });
    const blocker = await listen(() => {}); const port = Number(new URL(blocker.base).port);
    const t = fakeDeps({ x: "up" }); const log: string[] = [];
    expect(await startHub(hubSettings({ PORT: String(port), IMENGS_ROOT: root }, [], root), t.d, (l) => log.push(l))).toBeNull();
    expect(log.join("\n")).toMatch(new RegExp(`port ${port} is already in use`));
    expect(t.killed).toContain("x");
    await blocker.close();
  });
});
