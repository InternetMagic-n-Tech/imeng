import { describe, it, expect } from "@jest/globals";
import {
  estimateTokens, parseNvidiaSmi, detectHardware, kvLayout, kvBytes, maxContextThatFits, overheadFor, contextNeeds,
  serveCommand, satisfiesEngines, ollamaServeEnv, GiB, MiB,
} from "../src/utils/doctor.js";
import { gemmaInfo, llamaInfo, makeSys } from "./fake-sys.js";

describe("estimateTokens", () => {
  it("is about one token per four characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("parseNvidiaSmi", () => {
  it("reads name, total and used memory (MiB) for every GPU", () => {
    const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 1052\nNVIDIA A100, 40960, 0\n");
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({ name: "NVIDIA GeForce RTX 4090", vramTotal: 24564 * MiB, vramUsed: 1052 * MiB, kind: "nvidia" });
    expect(gpus[1].vramTotal).toBe(40960 * MiB);
  });
  it("skips garbage lines and tolerates a missing 'used' column", () => {
    expect(parseNvidiaSmi("not a gpu line\n\n")).toEqual([]);
    expect(parseNvidiaSmi("Some GPU, 8192")[0].vramUsed).toBeNull();
  });
});

describe("detectHardware", () => {
  it("reports CPU, RAM and an NVIDIA GPU", async () => {
    const hw = await detectHardware(makeSys());
    expect(hw).toMatchObject({ platform: "linux", cores: 24, cpuModel: "Fake CPU 9000", unified: false });
    expect(hw.gpus[0].name).toContain("4090");
    expect(hw.ramTotal).toBe(31 * GiB);
  });
  it("treats Apple Silicon as unified memory (three quarters usable)", async () => {
    const hw = await detectHardware(makeSys({ platform: "darwin", arch: "arm64", gpuCsv: null, ramTotal: 64 * GiB }));
    expect(hw.unified).toBe(true);
    expect(hw.gpus[0]).toMatchObject({ kind: "apple", vramTotal: 48 * GiB });
  });
  it("finds no GPU on other machines without nvidia-smi", async () => {
    const hw = await detectHardware(makeSys({ gpuCsv: null }));
    expect(hw.gpus).toEqual([]);
    expect(hw.unified).toBe(false);
  });
  it("copes with a CPU list that is empty", async () => {
    const sys = makeSys();
    sys.cpus = () => [];
    expect((await detectHardware(sys))).toMatchObject({ cpuModel: "unknown CPU", cores: 0 });
  });
});

describe("KV cache model", () => {
  it("reads Gemma's per-layer layout (sliding pattern, SWA head sizes, window, trained context)", () => {
    const l = kvLayout(gemmaInfo())!;
    expect(l.layers).toHaveLength(30);
    expect(l.slidingWindow).toBe(1024);
    expect(l.trainedContext).toBe(262144);
    expect(l.layers[0]).toEqual({ heads: 8, keyLen: 256, valueLen: 256, sliding: true });
    expect(l.layers[5]).toEqual({ heads: 2, keyLen: 512, valueLen: 512, sliding: false });
  });

  it("reads a plain model, deriving head size from the embedding width", () => {
    const l = kvLayout(llamaInfo())!;
    expect(l.layers).toHaveLength(32);
    expect(l.layers[0]).toEqual({ heads: 8, keyLen: 128, valueLen: 128, sliding: false });
    expect(l.slidingWindow).toBeNull();
  });

  it("uses head_count when there is no head_count_kv, and handles array head counts", () => {
    const info = { ...llamaInfo(), "llama.attention.head_count_kv": undefined };
    expect(kvLayout(info)!.layers[0].heads).toBe(32);
  });

  it("returns null when the info is missing or unusable", () => {
    expect(kvLayout(undefined)).toBeNull();
    expect(kvLayout({})).toBeNull();
    expect(kvLayout({ "general.architecture": "x" })).toBeNull();
    expect(kvLayout({ "general.architecture": "x", "x.block_count": 4 })).toBeNull();
    expect(kvLayout({ ...llamaInfo(), "llama.attention.head_count_kv": ["a", "b"] })).toBeNull();
  });

  it("computes bytes: full attention vs sliding-window aware", () => {
    const l = kvLayout(gemmaInfo())!;
    // 25 sliding layers: 8 heads * (256+256) * 2 B = 8192 B/token; 5 global layers: 2 * (512+512) * 2 = 4096 B/token
    expect(kvBytes(l, 1000)).toBe((25 * 8192 + 5 * 4096) * 1000);
    expect(kvBytes(l, 32768, true)).toBe(25 * 8192 * 1024 + 5 * 4096 * 32768);
    expect(kvBytes(l, 512, true)).toBe(kvBytes(l, 512)); // shorter than the window: identical
  });

  it("finds the largest context (multiple of 1024) that fits", () => {
    const l = kvLayout({ ...llamaInfo(), "llama.context_length": 262144 })!; // 131072 B/token, no practical cap
    const fit = maxContextThatFits(10 * GiB, 5 * GiB, l, 1 * GiB);
    expect(fit % 1024).toBe(0);
    expect(5 * GiB + kvBytes(l, fit) + 1 * GiB).toBeLessThanOrEqual(10 * GiB);
    expect(5 * GiB + kvBytes(l, fit + 1024) + 1 * GiB).toBeGreaterThan(10 * GiB);
  });

  it("returns 0 when even a tiny context does not fit", () => {
    expect(maxContextThatFits(4 * GiB, 5 * GiB, kvLayout(llamaInfo())!, 1 * GiB)).toBe(0);
  });

  it("is capped at the model's trained context, and multiplies KV by parallel slots", () => {
    const l = kvLayout(llamaInfo())!; // trained 8192
    expect(maxContextThatFits(80 * GiB, 5 * GiB, l, 1 * GiB)).toBe(8192);
    const one = maxContextThatFits(14 * GiB, 5 * GiB, kvLayout(gemmaInfo())!, 1 * GiB, 1, false);
    const four = maxContextThatFits(14 * GiB, 5 * GiB, kvLayout(gemmaInfo())!, 1 * GiB, 4, false);
    expect(four).toBeLessThan(one);
  });

  it("sliding-window awareness lets a much larger context fit", () => {
    const l = kvLayout(gemmaInfo())!;
    const swa = maxContextThatFits(24 * GiB, 17.4 * GiB, l, overheadFor(24 * GiB), 1, true);
    const full = maxContextThatFits(24 * GiB, 17.4 * GiB, l, overheadFor(24 * GiB), 1, false);
    expect(swa).toBeGreaterThan(full);
  });

  it("keeps a safety margin for the runtime", () => {
    expect(overheadFor(8 * GiB)).toBe(1.5 * GiB);
    expect(overheadFor(24 * GiB)).toBe(Math.round(24 * GiB * 0.08));
  });
});

describe("contextNeeds", () => {
  it("adds state growth, a reply and some conversation to the fixed prompt", () => {
    const n = contextNeeds(2000);
    expect(n.base).toBe(2000 + 1500 + 800);
    expect(n.minimum).toBeGreaterThan(n.base);
    expect(n.comfortable).toBeGreaterThan(n.minimum);
  });
});

describe("serveCommand", () => {
  it("builds a shell command with env assignments, quoting values that need it", () => {
    expect(serveCommand("linux", { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_ORIGINS: "http://a b" })).toBe('OLLAMA_HOST=0.0.0.0:11434 OLLAMA_ORIGINS="http://a b" ollama serve');
  });
  it("uses PowerShell syntax on Windows", () => {
    expect(serveCommand("win32", { OLLAMA_CONTEXT_LENGTH: "8192" })).toBe('$env:OLLAMA_CONTEXT_LENGTH="8192"; ollama serve');
  });
});

describe("satisfiesEngines", () => {
  it.each([
    ["v22.23.4", ">=22.9.0 <23", true],
    ["v22.9.0", ">=22.9.0 <23", true],
    ["v22.8.9", ">=22.9.0 <23", false],
    ["v23.0.0", ">=22.9.0 <23", false],
    ["v20.1.0", ">=22.9.0 <23", false],
    ["v22.0.0", ">=22 <23", true],
    ["v18.0.0", undefined, true],
    ["v18.0.0", "weird range", true],
  ])("%s against %s -> %s", (v, range, expected) => {
    expect(satisfiesEngines(v, range)).toBe(expected);
  });
});

describe("ollamaServeEnv", () => {
  it("reads only the OLLAMA_* variables of the running server (Linux)", async () => {
    const env = await ollamaServeEnv(makeSys({ serveEnv: { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_KEEP_ALIVE: "15m" } }));
    expect(env).toEqual({ OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_KEEP_ALIVE: "15m" });
  });
  it("skips ollama processes that are not the server, and unreadable ones", async () => {
    const sys = makeSys({ files: { "/proc/4242/cmdline": "ollama\0run\0gemma\0" } });
    expect(await ollamaServeEnv(sys)).toBeNull();
    const noEnv = makeSys({ files: { "/proc/4242/environ": "" } });
    noEnv.readFile = (p) => (p.endsWith("environ") ? null : "ollama\0serve\0");
    expect(await ollamaServeEnv(noEnv)).toBeNull();
  });
  it("is Linux-only, and null when there is no ollama process", async () => {
    expect(await ollamaServeEnv(makeSys({ platform: "darwin" }))).toBeNull();
    expect(await ollamaServeEnv(makeSys({ serveEnv: null }))).toBeNull();
  });
  it("ignores malformed environment entries", async () => {
    const sys = makeSys({ files: { "/proc/4242/environ": "NOEQUALS\0=weird\0OLLAMA_X=1\0" } });
    expect(await ollamaServeEnv(sys)).toEqual({ OLLAMA_X: "1" });
  });
});
