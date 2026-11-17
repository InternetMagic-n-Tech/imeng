import type { HttpResult, Settings, Sys } from "../src/utils/doctor.js";
import { GiB, MiB } from "../src/utils/doctor.js";

/** model_info shaped like Gemma 4's: per-layer KV heads, a sliding-window pattern, separate SWA head sizes. */
export function gemmaInfo(): Record<string, unknown> {
  const heads = Array.from({ length: 5 }, () => [8, 8, 8, 8, 8, 2]).flat();
  const pattern = Array.from({ length: 5 }, () => [true, true, true, true, true, false]).flat();
  return {
    "general.architecture": "gemma4", "gemma4.block_count": 30, "gemma4.context_length": 262144,
    "gemma4.embedding_length": 2816, "gemma4.attention.head_count": 16, "gemma4.attention.head_count_kv": heads,
    "gemma4.attention.key_length": 512, "gemma4.attention.value_length": 512,
    "gemma4.attention.key_length_swa": 256, "gemma4.attention.value_length_swa": 256,
    "gemma4.attention.sliding_window": 1024, "gemma4.attention.sliding_window_pattern": pattern,
  };
}

/** A plain (non sliding-window) model: 32 layers, 8 KV heads of 128 dims. */
export function llamaInfo(): Record<string, unknown> {
  return {
    "general.architecture": "llama", "llama.block_count": 32, "llama.context_length": 8192,
    "llama.embedding_length": 4096, "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8,
  };
}

export interface FakeOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  ramTotal?: number;
  ramFree?: number;
  gpuCsv?: string | null;                    // nvidia-smi output; null = no nvidia-smi
  serveEnv?: Record<string, string> | null;  // environment of `ollama serve` (Linux); null = unreadable
  routes?: Record<string, HttpResult | null>; // "GET url" / "POST url" -> result (null = connection refused)
  exec?: Record<string, string | null>;       // cmd -> stdout (null = missing)
  files?: Record<string, string>;
  portsInUse?: number[];
  redis?: { ok: boolean; error?: string };
  dockerEnv?: boolean;
}

const BASE = "http://localhost:11434";

/** The default world: a healthy RTX 4090 / gemma4:26b machine with Ollama running and nothing loaded. */
export function defaultRoutes(): Record<string, HttpResult | null> {
  return {
    [`GET ${BASE}/api/version`]: { ok: true, status: 200, json: { version: "0.40.0" } },
    [`GET ${BASE}/api/tags`]: { ok: true, status: 200, json: { models: [
      { name: "gemma4:26b", size: Math.round(17.4 * GiB) },
      { name: "jev:latest", size: Math.round(4.7 * GiB) },
    ] } },
    [`GET ${BASE}/api/ps`]: { ok: true, status: 200, json: { models: [] } },
    [`POST ${BASE}/api/show`]: { ok: true, status: 200, json: { model_info: gemmaInfo() } },
    [`GET http://127.0.0.1:3001/healthz`]: null,
  };
}

export function makeSys(o: FakeOptions = {}): Sys & { calls: string[] } {
  const calls: string[] = [];
  const routes = { ...defaultRoutes(), ...(o.routes || {}) };
  const serveEnv = o.serveEnv === undefined ? { OLLAMA_CONTEXT_LENGTH: "32768", OLLAMA_KEEP_ALIVE: "15m", OLLAMA_HOST: "127.0.0.1:11434" } : o.serveEnv;
  const exec: Record<string, string | null> = {
    "nvidia-smi": o.gpuCsv === undefined ? "NVIDIA GeForce RTX 4090, 24564, 1052\n" : o.gpuCsv,
    pgrep: serveEnv ? "4242\n" : null,
    which: "/usr/local/bin/ollama\n",
    where: "C:\\Ollama\\ollama.exe\n",
    docker: "",
    ...(o.exec || {}),
  };
  const files: Record<string, string> = {
    ...(serveEnv ? { "/proc/4242/cmdline": "ollama\0serve\0", "/proc/4242/environ": Object.entries(serveEnv).map(([k, v]) => `${k}=${v}`).join("\0") + "\0PATH=/usr/bin\0" } : {}),
    ...(o.files || {}),
  };
  const existing = new Set([...(o.dockerEnv ? ["/.dockerenv"] : []), ...Object.keys(files)]);
  return {
    calls,
    platform: o.platform ?? "linux",
    arch: o.arch ?? "x64",
    nodeVersion: o.nodeVersion ?? "v22.23.4",
    env: {},
    totalmem: () => o.ramTotal ?? 31 * GiB,
    freemem: () => o.ramFree ?? 20 * GiB,
    cpus: () => Array.from({ length: 24 }, () => ({ model: "Fake CPU 9000 " })),
    exec: async (cmd) => { calls.push(`exec ${cmd}`); return cmd in exec ? exec[cmd] : null; },
    http: async (url, init) => { const key = `${init?.method || "GET"} ${url}`; calls.push(key); return key in routes ? routes[key] : null; },
    exists: (p) => existing.has(p),
    readFile: (p) => files[p] ?? null,
    portFree: async (port) => !(o.portsInUse || []).includes(port),
    redisPing: async () => o.redis ?? { ok: true },
  };
}

export function makeSettings(over: Partial<Settings> = {}): Settings {
  const prompt = 'If the user\'s first message is "Imeng: X" follow these instructions.\nUse the pre-rolled dice provided, in order.\n';
  return {
    upstream: `${BASE}/v1`, model: "gemma4:26b", judgeModel: "jev", judgeUrl: "",
    judgeInstance: { port: 11435, num_ctx: 8192, gpu: false }, judgeNumCtx: 8192,
    gameDir: "/game", systemPrompt: prompt, fixedPromptText: prompt + "x".repeat(7000), game: {},
    invocation: "judge", dice: true, port: 3001, redisUrl: "redis://fake", nodeEngines: ">=22.9.0 <23", promptFileFound: true,
    ...over,
  };
}

export { MiB, GiB, BASE };
