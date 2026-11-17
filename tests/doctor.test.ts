import { describe, it, expect } from "@jest/globals";
import { runDoctor, isProblem, GiB } from "../src/utils/doctor.js";
import type { Finding, Report } from "../src/utils/doctor.js";
import { BASE, gemmaInfo, llamaInfo, makeSettings, makeSys } from "./fake-sys.js";

const find = (r: Report, id: string): Finding | undefined => r.findings.find((f) => f.id === id);
const levelOf = (r: Report, id: string) => find(r, id)?.level;
const run = (sysOpts = {}, settings = {}, opts = {}) => runDoctor(makeSys(sysOpts), makeSettings(settings), opts);
const route = (path: string, result: any, method = "GET") => ({ [`${method} ${BASE}${path}`]: result });

describe("a healthy machine", () => {
  it("has no warnings or failures", async () => {
    const r = await run({}, {}, {});
    expect(r.findings.filter(isProblem)).toEqual([]);
    expect(r.bailed).toBe(false);
    expect(r.suggestion).toBeUndefined();
    for (const id of ["node-version", "hw-ram", "hw-gpu", "game-files", "game-config", "prompt-dice", "invocation", "backend", "model-installed", "ollama-keepalive", "ctx-needed", "judge-reachable", "judge-installed", "judge-fit", "port", "redis"]) {
      expect(levelOf(r, id)).toBe("ok");
    }
  });

  it("estimates the prompt cost and the room for conversation", async () => {
    const r = await run();
    expect(find(r, "prompt-size")!.title).toMatch(/≈ \d+ tokens per turn/);
    expect(find(r, "ctx-needed")!.title).toMatch(/room for about \d+ exchanges/);
  });
});

describe("runtime and hardware", () => {
  it("fails when Node is outside the supported range", async () => {
    const r = await run({ nodeVersion: "v18.0.0" });
    expect(levelOf(r, "node-version")).toBe("fail");
  });
  it("warns when RAM is small", async () => {
    expect(levelOf(await run({ ramTotal: 8 * GiB }), "hw-ram")).toBe("warn");
  });
  it("explains what it skips when no GPU is found", async () => {
    const r = await run({ gpuCsv: null });
    expect(levelOf(r, "hw-gpu")).toBe("info");
    expect(levelOf(r, "ctx-fit")).toBe("info");
  });
  it("reports unified memory on Apple Silicon", async () => {
    const r = await run({ platform: "darwin", arch: "arm64", gpuCsv: null, serveEnv: null });
    expect(find(r, "hw-gpu")!.title).toContain("shared with system memory");
  });
});

describe("game files and configuration", () => {
  it("warns when SYSTEM_PROMPT.md is missing", async () => {
    expect(levelOf(await run({}, { promptFileFound: false }), "game-files")).toBe("warn");
  });

  it("fails on inconsistent config.json", async () => {
    const r = await run({}, { game: {
      session_rules: [{ id: "a", text: "x" }, { id: "a", text: "y" }, { id: "", text: "" }],
      setup_turns: -1, exit_when: [{ field: "", lte: undefined }], exit_group_when: [{ field: "w", lte: 1, share: 2 }], judge_confirmations: 0,
    } as any });
    const f = find(r, "game-config")!;
    expect(f.level).toBe("fail");
    for (const p of ["duplicate ids", "missing its id or text", "setup_turns", "exit_when", "exit_group_when", "judge_confirmations"]) expect(f.detail).toContain(p);
  });

  it("checks unique_fields and decrease_locks", async () => {
    const r = await run({}, { game: { unique_fields: ["ok", ""], decrease_locks: [{ field: "a", while: { field: "b" } }] } as any });
    const d = find(r, "game-config")!.detail!;
    expect(d).toContain("unique_fields must be a list");
    expect(d).toContain("a decrease_locks rule needs");
    const r2 = await run({}, { game: { allowed_values: { "game.x": [] } } as any });
    expect(find(r2, "game-config")!.detail).toContain("allowed_values must map a field");
    const r3 = await run({}, { game: { sticky_fields: { "game.x": 0 } } as any });
    expect(find(r3, "game-config")!.detail).toContain("sticky_fields must map");
    const good = await run({}, { game: { unique_fields: ["tags"], decrease_locks: [{ field: "a", while: { field: "b", gt: 0 } }, { field: "c" }] } as any });
    expect(find(good, "game-config")!.level).not.toBe("fail");
  });

  it("checks game_turn and turn_events", async () => {
    const detail = async (game: object) => find(await run({}, { game: game as any }), "game-config")!.detail ?? "";
    expect(await detail({ turn_events: [{ at: 2, text: "x" }] })).toMatch(/turn_events needs game_turn/);
    expect(await detail({ game_turn: { advance: "field" } })).toMatch(/needs field/);
    expect(await detail({ game_turn: { advance: "judged" } })).toMatch(/needs a rule/);
    const bad = await detail({ game_turn: {}, turn_events: [{ text: "x" }, { at: 1, every: 2, end: true }, { at: 3, if: { field: "stain" }, set: { "actors.user.hp": 1 } }] });
    expect(bad).toMatch(/needs at or every/);
    expect(bad).toMatch(/has both at and every/);
    expect(bad).toMatch(/ends the game and needs text/);
    expect(bad).toMatch(/needs lt, lte, gt, gte, eq, present or is/);
    expect(bad).toMatch(/set paths must be game/);
    expect(levelOf(await run({}, { game: { game_turn: { advance: "round" }, turn_events: [{ at: 2, text: "x" }] } as any }), "game-config")).toBe("ok");
  });
  it("warns when knowledge is on without a judge_model", async () => {
    expect(levelOf(await run({}, { game: { knowledge: { enabled: true } } as any }), "knowledge-judge")).toBe("warn");
    expect(find(await run({}, { game: { knowledge: { enabled: true }, judge_model: "j" } as any }), "knowledge-judge")).toBeUndefined();
    expect(find(await run({}, { game: {} as any }), "knowledge-judge")).toBeUndefined();
  });
  it("checks the machine guard against the game's own thresholds, and flags the old history_limit name", async () => {
    process.env.CONTEXT_MAX_TOKENS = "20000";
    try {
      const r = await run({}, { game: { compaction: { at_tokens: 19000 }, wrap_up: { at_tokens: 26000 } } as any });
      expect(find(r, "game-config")!.detail).toMatch(/CONTEXT_MAX_TOKENS \(20000\) must be above wrap_up.at_tokens/);
      expect(find(r, "game-config")!.detail).not.toMatch(/compaction.at_tokens/);
    } finally { delete process.env.CONTEXT_MAX_TOKENS; }
    const old = await run({}, { game: { history_limit: 10 } as any });
    expect(levelOf(old, "game-history-limit")).toBe("warn");
    expect(find(await run({}, { game: { history_limit: 10, actor_history_limit: 10 } as any }), "game-history-limit")).toBeUndefined();
  });
  it("checks the wrap_up turn budget", async () => {
    const r = await run({}, { game: { wrap_up: { at_turn: 3, soon_turns: 5 } } as any });
    expect(find(r, "game-config")!.detail).toContain("soon_turns needs an at_turn above it");
    const r2 = await run({}, { game: { wrap_up: { at_turn: 1.5, text: "x" } } as any });
    expect(find(r2, "game-config")!.detail).toContain("at_turn must be a whole number");
    const r3 = await run({}, { game: { wrap_up: { text: "x" } } as any });
    expect(find(r3, "game-config")!.detail).toContain("needs at_tokens or at_turn");
  });

  it("fails an exit_group_when rule that is already true for a fresh cast", async () => {
    const r = await run({}, { game: { actor_template: { warmth: 10 }, initial_state: { game: {}, actors: { user: { warmth: 10 } } }, exit_group_when: [{ field: "warmth", gte: 8, share: 0.6 }, { field: "warmth", lte: 2 }] } as any });
    const f = find(r, "game-config")!;
    expect(f.level).toBe("fail");
    expect(f.detail).toContain('on "warmth" is already true at the start');
    expect(f.detail!.match(/already true/g)).toHaveLength(1);
  });

  it("checks the world block: a custom era needs a canon file, and block needs enforce_rules", async () => {
    const f = find(await run({}, { game: { world: { era: "custom" } } as any }), "game-config")!;
    expect(f.level).toBe("fail");
    expect(f.detail).toContain("give world.canon.file");
    expect(f.detail).toContain("set enforce_rules to true");
    expect(levelOf(await run({}, { game: { world: { era: "custom", canon: { file: "c.md" }, anachronism: "warn" } } as any }), "game-config")).toBe("ok");
    expect(levelOf(await run({}, { game: { world: { era: "1990s" }, enforce_rules: true } as any }), "game-config")).toBe("ok");
  });
  it("validates the settings that shape the engine (dice pool, ids, writable fields, step limits, prompts)", async () => {
    const r = await run({}, { game: {
      dice: { d20: 0, banana: 3 }, user_id: "", npc_prefix: 5, writable_fields: "hp", limits: { gold: { max_step: 0 } }, prompts: { extractor: 7 },
    } as any });
    const f = find(r, "game-config")!;
    expect(f.level).toBe("fail");
    for (const p of ["dice must be true or an object", "user_id must be", "npc_prefix must be", "writable_fields must be a list", "max_step must be greater than 0", "prompts values must be text"]) expect(f.detail).toContain(p);
    expect(levelOf(await run({}, { game: { dice: { d6: 3 }, user_id: "player", npc_prefix: "guest_", writable_fields: ["hp"], limits: { hp: { max_step: 5 } }, prompts: { extractor: "x" } } }), "game-config")).toBe("ok");
  });

  it("uses the game's own trigger pattern when it has one", async () => {
    const sp = "Si el primer mensaje es \"X\" sigue.";
    expect(levelOf(await run({}, { systemPrompt: sp, dice: false }), "invocation")).toBe("info"); // built-in English pattern misses it
    expect(levelOf(await run({}, { systemPrompt: sp, dice: false, triggerPattern: /si el primer mensaje es/i }), "invocation")).toBe("ok");
  });

  it("flags a dice block the prompt never mentions, and a prompt that expects dice that never come", async () => {
    expect(levelOf(await run({}, { dice: true, systemPrompt: "You narrate.", fixedPromptText: "You narrate." }), "prompt-dice")).toBe("warn");
    expect(levelOf(await run({}, { dice: false, systemPrompt: "Use the pre-rolled dice." }), "prompt-dice")).toBe("warn");
    expect(levelOf(await run({}, { dice: false, systemPrompt: "Roll a d20 yourself." }), "prompt-dice")).toBe("ok");
    expect(find(await run({}, { dice: false, systemPrompt: "You narrate." }), "prompt-dice")!.title).toBe("Dice are off");
  });

  it("checks the invocation setting against the prompt's trigger sentence", async () => {
    expect(levelOf(await run({}, { invocation: "always" }), "invocation")).toBe("warn");
    expect(levelOf(await run({}, { systemPrompt: "You narrate.", dice: false }), "invocation")).toBe("info");
  });
});

describe("the model server", () => {
  it("fails with a start command when nothing is running but ollama is installed", async () => {
    const r = await run({ routes: { ...route("/api/version", null), [`GET ${BASE}/v1/models`]: null } });
    const f = find(r, "backend")!;
    expect(f.level).toBe("fail");
    expect(f.detail).toContain("installed");
    expect(f.fix).toContain("ollama serve");
  });

  it("says to install Ollama when the binary is missing, and uses PowerShell syntax on Windows", async () => {
    const dead = { ...route("/api/version", null), [`GET ${BASE}/v1/models`]: null };
    const missing = await run({ routes: dead, exec: { which: null } });
    expect(find(missing, "backend")!.fix).toContain("Install Ollama");
    const win = await run({ platform: "win32", routes: dead, serveEnv: null });
    expect(find(win, "backend")!.fix).toContain('$env:OLLAMA_HOST="127.0.0.1:11434"; ollama serve');
  });

  it("recognises an OpenAI-compatible server such as llama.cpp and reads its context", async () => {
    const openai = (n_ctx: number) => ({
      routes: { ...route("/api/version", null), [`GET ${BASE}/v1/models`]: { ok: true, status: 200, json: { data: [{ id: "gemma4:26b" }] } }, [`GET ${BASE}/props`]: { ok: true, status: 200, json: { default_generation_settings: { n_ctx } } } },
    });
    const good = await run(openai(16384));
    expect(levelOf(good, "backend")).toBe("info");
    expect(levelOf(good, "model-installed")).toBe("ok");
    expect(levelOf(good, "ctx-needed")).toBe("ok");
    expect(levelOf(await run(openai(2048)), "ctx-needed")).toBe("fail");
  });

  it("warns when an OpenAI-compatible server does not serve the model", async () => {
    const r = await run({ routes: { ...route("/api/version", null), [`GET ${BASE}/v1/models`]: { ok: true, status: 200, json: {} } } });
    expect(levelOf(r, "model-installed")).toBe("warn");
  });

  it("the judge sharing an OpenAI-compatible server fails clearly", async () => {
    const r = await run({ routes: { ...route("/api/version", null), [`GET ${BASE}/v1/models`]: { ok: true, status: 200, json: { data: [] } } } }, { judgeInstance: null });
    expect(find(r, "judge-reachable")!.title).toContain("native API");
  });

  it("fails inside a container when UPSTREAM is localhost", async () => {
    const r = await run({ dockerEnv: true });
    expect(levelOf(r, "upstream-container")).toBe("fail");
    expect(levelOf(await run({ dockerEnv: true }, { upstream: "http://host.docker.internal:11434/v1" }), "upstream-container")).toBeUndefined();
  });

  it("warns when Ollama itself runs in Docker", async () => {
    expect(levelOf(await run({ exec: { docker: "ollama/ollama:latest ollama\n" } }), "ollama-in-docker")).toBe("warn");
  });

  it("fails when the narrator model is not installed (and stops model checks there)", async () => {
    const r = await run({}, { model: "nope:1b" });
    expect(levelOf(r, "model-installed")).toBe("fail");
    expect(find(r, "model-installed")!.fix).toContain("ollama pull nope:1b");
    expect(find(r, "ctx-needed")).toBeUndefined();
  });

  it("accepts a model named without its :latest tag", async () => {
    expect(levelOf(await run({}, { model: "jev" }), "model-installed")).toBe("ok");
  });
});

describe("Ollama's own settings", () => {
  it("warns that 0.0.0.0 exposes an unauthenticated server", async () => {
    const r = await run({ serveEnv: { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_CONTEXT_LENGTH: "8192" } });
    expect(levelOf(r, "ollama-exposed")).toBe("warn");
    expect(levelOf(await run({ serveEnv: { OLLAMA_HOST: "[::]:11434", OLLAMA_CONTEXT_LENGTH: "8192" } }), "ollama-exposed")).toBe("warn");
    expect(levelOf(await run({ serveEnv: { OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_CONTEXT_LENGTH: "8192" } }), "ollama-exposed")).toBeUndefined();
  });

  it("warns when keep-alive unloads the model after each request", async () => {
    expect(levelOf(await run({ serveEnv: { OLLAMA_KEEP_ALIVE: "0", OLLAMA_CONTEXT_LENGTH: "8192" } }), "ollama-keepalive")).toBe("warn");
  });

  it("warns about a models directory this account cannot see", async () => {
    expect(levelOf(await run({ serveEnv: { OLLAMA_MODELS: "/nope", OLLAMA_CONTEXT_LENGTH: "8192" } }), "ollama-models")).toBe("warn");
  });

  it("explains when the server's environment cannot be read", async () => {
    const r = await run({ serveEnv: null, platform: "darwin" });
    expect(find(r, "ollama-env")!.detail).toContain("Only readable on Linux");
    expect(find(await run({ serveEnv: null }), "ollama-env")!.detail).toContain("No running `ollama serve`");
  });

  it("shows the server's settings when they can be read", async () => {
    expect(find(await run({ serveEnv: {} }), "ollama-env")!.detail).toContain("defaults apply");
  });
});

describe("context length", () => {
  it("fails when the context is too small for this game", async () => {
    const r = await run({ serveEnv: { OLLAMA_CONTEXT_LENGTH: "4096" } });
    expect(levelOf(r, "ctx-needed")).toBe("fail");
  });

  it("warns about a context beyond what the model was trained for", async () => {
    const r = await run({ serveEnv: { OLLAMA_CONTEXT_LENGTH: "16384" }, routes: route("/api/show", { ok: true, status: 200, json: { model_info: llamaInfo() } }, "POST") });
    expect(levelOf(r, "ctx-trained")).toBe("warn");
  });

  it("is informational when the context is not known yet", async () => {
    expect(levelOf(await run({ serveEnv: {} }), "ctx-needed")).toBe("info");
  });

  it("falls back to the loaded model's context when the server env cannot be read", async () => {
    const r = await run({ serveEnv: null, routes: route("/api/ps", { ok: true, status: 200, json: { models: [{ name: "gemma4:26b", size: 20 * GiB, size_vram: 20 * GiB, context_length: 16384 }] } }) });
    expect(find(r, "ctx-needed")!.title).toContain("Context 16384");
  });
});

describe("does it fit in VRAM?", () => {
  it("is ok when even the full-size KV upper bound fits", async () => {
    expect(levelOf(await run({ serveEnv: { OLLAMA_CONTEXT_LENGTH: "8192" } }), "ctx-fit")).toBe("ok");
  });

  it("is informational when it fits only with sliding-window KV caching (a 24 GB GPU at 32768)", async () => {
    const r = await run();
    const f = find(r, "ctx-fit")!;
    expect(f.level).toBe("info");
    expect(f.detail).toContain("--probe");
    expect(r.suggestion).toBeUndefined();
  });

  it("warns, recommends a context and suggests a start command when it cannot fit", async () => {
    const r = await run({ gpuCsv: "Small GPU, 20480, 100\n", serveEnv: { OLLAMA_CONTEXT_LENGTH: "262144", OLLAMA_HOST: "127.0.0.1:11434" } });
    const f = find(r, "ctx-fit")!;
    expect(f.level).toBe("warn");
    expect(f.fix).toMatch(/up to ~\d+ tokens/);
    expect(r.suggestion!.contextLength).toBeLessThan(262144);
    expect(r.suggestion!.command).toContain(`OLLAMA_CONTEXT_LENGTH=${r.suggestion!.contextLength}`);
    expect(r.suggestion!.command).toContain("ollama serve");
  });

  it("fails when the model cannot fit even at the game's minimum", async () => {
    const r = await run({ gpuCsv: "Tiny GPU, 12288, 0\n" });
    expect(levelOf(r, "ctx-fit")).toBe("fail");
  });

  it("multiplies the KV cache by OLLAMA_NUM_PARALLEL", async () => {
    const one = await run({ gpuCsv: "G, 24564, 0\n", serveEnv: { OLLAMA_CONTEXT_LENGTH: "65536", OLLAMA_NUM_PARALLEL: "1" } });
    const many = await run({ gpuCsv: "G, 24564, 0\n", serveEnv: { OLLAMA_CONTEXT_LENGTH: "65536", OLLAMA_NUM_PARALLEL: "8" } });
    expect(find(many, "ctx-fit")!.detail).toContain("x8 parallel");
    expect(find(one, "ctx-fit")!.detail).not.toContain("parallel");
  });

  it("does not estimate when the model layout is unavailable", async () => {
    const r = await run({ routes: route("/api/show", { ok: true, status: 200, json: {} }, "POST") });
    expect(find(r, "ctx-fit")!.detail).toBeUndefined();
    expect(find(r, "ctx-fit")!.title).toContain("layout isn't available");
  });
});

describe("what is actually loaded", () => {
  const loaded = (size: number, vram: number, ctx = 32768) => route("/api/ps", { ok: true, status: 200, json: { models: [{ name: "gemma4:26b", size, size_vram: vram, context_length: ctx }] } });

  it("warns about CPU offload and says what context would fix a small overflow", async () => {
    const r = await run({ routes: loaded(20 * GiB, 19.6 * GiB) });
    const f = find(r, "ctx-offload")!;
    expect(f.level).toBe("warn");
    expect(f.title).toContain("2% of the model");
    expect(f.detail).toMatch(/Reducing the context to roughly \d+/);
    expect(f.fix).toContain("Lower OLLAMA_CONTEXT_LENGTH");
  });

  it("says a smaller context will not help when the overflow is bigger than the KV cache", async () => {
    const r = await run({ routes: loaded(25 * GiB, 18.75 * GiB) });
    const f = find(r, "ctx-offload")!;
    expect(f.title).toContain("25% of the model");
    expect(f.detail).toContain("will not fix it");
    expect(f.fix).toContain("GPU-resident judge");
  });

  it("still warns, with generic advice, when the model layout is unknown", async () => {
    const r = await run({ routes: { ...loaded(25 * GiB, 18.75 * GiB), ...route("/api/show", { ok: true, status: 200, json: {} }, "POST") } });
    expect(find(r, "ctx-offload")!.fix).toContain("Free VRAM");
  });

  it("is ok when the model is fully on the GPU", async () => {
    expect(levelOf(await run({ routes: loaded(20 * GiB, 20 * GiB) }), "ctx-offload")).toBe("ok");
  });

  it("offers no number when the reduction would go below the game's minimum", async () => {
    const r = await run({ routes: loaded(40 * GiB, 10 * GiB), serveEnv: { OLLAMA_CONTEXT_LENGTH: "9000" } });
    expect(find(r, "ctx-offload")!.detail).not.toContain("Reducing");
  });

  it("is informational when the model is not loaded", async () => {
    expect(levelOf(await run(), "ctx-offload")).toBe("info");
  });
});

describe("the judge", () => {
  it("shares the narrator's server when no instance or URL is configured", async () => {
    const r = await run({}, { judgeInstance: null });
    expect(find(r, "judge-target")!.title).toContain("shares the narrator's server");
    expect(levelOf(r, "judge-reachable")).toBe("ok");
  });

  it("checks a remote judge (JUDGE_URL): reachable and installed, or a clear failure", async () => {
    const url = "http://host.docker.internal:11435";
    const up = await run({ routes: { [`GET ${url}/api/version`]: { ok: true, status: 200, json: {} }, [`GET ${url}/api/tags`]: { ok: true, status: 200, json: { models: [{ name: "jev:latest", size: 4 * GiB }] } } } }, { judgeUrl: url, judgeInstance: null });
    expect(levelOf(up, "judge-reachable")).toBe("ok");
    expect(levelOf(up, "judge-installed")).toBe("ok");
    const down = await run({}, { judgeUrl: url, judgeInstance: null });
    expect(levelOf(down, "judge-reachable")).toBe("fail");
    expect(find(down, "judge-reachable")!.fix).toContain("npm run judge");
  });

  it("can start its own instance when ollama is installed and the port is free", async () => {
    expect(find(await run(), "judge-reachable")!.title).toContain("the proxy can start it");
  });

  it("fails when it cannot be started", async () => {
    const noBin = await run({ exec: { which: null } });
    expect(find(noBin, "judge-reachable")!.detail).toContain("not found on PATH");
    const taken = await run({ portsInUse: [11435] });
    expect(find(taken, "judge-reachable")!.detail).toContain("taken");
  });

  it("is happy when its Ollama is already up, and checks the model there", async () => {
    const r = await run({ routes: { "GET http://127.0.0.1:11435/api/version": { ok: true, status: 200, json: {} }, "GET http://127.0.0.1:11435/api/tags": { ok: true, status: 200, json: { models: [] } } } });
    expect(levelOf(r, "judge-reachable")).toBe("ok");
    expect(levelOf(r, "judge-installed")).toBe("fail");
  });

  it("warns about a models_dir that does not exist here, and a small judge context", async () => {
    const r = await run({}, { judgeNumCtx: 2048, judgeInstance: { port: 11435, gpu: false, models_dir: "/models" } });
    expect(levelOf(r, "judge-models-dir")).toBe("warn");
    expect(levelOf(await run({ files: { "/models": "" } }, { judgeInstance: { port: 11435, gpu: false, models_dir: "/models" } }), "judge-models-dir")).toBeUndefined();
    expect(levelOf(r, "judge-ctx")).toBe("warn");
  });

  it("fails when the judge model is not installed", async () => {
    const r = await run({}, { judgeModel: "missing-judge" });
    expect(levelOf(r, "judge-installed")).toBe("fail");
  });

  it("warns when a CPU judge will not fit in free RAM", async () => {
    expect(levelOf(await run({ ramFree: 2 * GiB }), "judge-fit")).toBe("warn");
  });

  it("warns when a GPU judge plus the narrator exceed VRAM (the contention we hit earlier)", async () => {
    const dir = { port: 11435, gpu: true };
    const gpuJudgeUp = { "GET http://127.0.0.1:11435/api/version": { ok: true, status: 200, json: {} }, "GET http://127.0.0.1:11435/api/tags": { ok: true, status: 200, json: { models: [{ name: "jev:latest", size: 8 * GiB }] } } };
    expect(levelOf(await run({ routes: gpuJudgeUp }, { judgeInstance: dir }), "judge-fit")).toBe("warn");
    const small = { ...gpuJudgeUp, "GET http://127.0.0.1:11435/api/tags": { ok: true, status: 200, json: { models: [{ name: "jev:latest", size: 1 * GiB }] } } };
    expect(levelOf(await run({ routes: small, gpuCsv: "Big, 81920, 0\n" }, { judgeInstance: dir }), "judge-fit")).toBe("ok");
  });
});

describe("around the proxy", () => {
  it("handles the port being busy: by the proxy itself, or by something else", async () => {
    expect(levelOf(await run({ portsInUse: [3001], routes: { "GET http://127.0.0.1:3001/healthz": { ok: true, status: 200, json: { ok: true } } } }), "port")).toBe("info");
    expect(levelOf(await run({ portsInUse: [3001] }), "port")).toBe("warn");
  });

  it("covers Redis: unset, up and down", async () => {
    expect(levelOf(await run({}, { redisUrl: "" }), "redis")).toBe("info");
    expect(levelOf(await run({ redis: { ok: false, error: "ECONNREFUSED" } }), "redis")).toBe("warn");
  });
});

describe("--bail and --ignore", () => {
  const exposed = { serveEnv: { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_CONTEXT_LENGTH: "32768" } };

  it("--bail stops at the first problem and reports it", async () => {
    const r = await run(exposed, {}, { bail: true });
    expect(r.bailed).toBe(true);
    expect(r.findings.at(-1)!.id).toBe("ollama-exposed");
    expect(find(r, "judge-target")).toBeUndefined(); // never reached
  });

  it("without --bail every check runs even when something is wrong", async () => {
    const r = await run(exposed);
    expect(r.bailed).toBe(false);
    expect(find(r, "redis")).toBeDefined();
  });

  it("--ignore turns a known, accepted problem into information", async () => {
    const r = await run(exposed, {}, { bail: true, ignore: ["ollama-exposed"] });
    expect(r.bailed).toBe(false);
    expect(find(r, "ollama-exposed")).toMatchObject({ level: "info" });
    expect(find(r, "ollama-exposed")!.title).toContain("(ignored)");
  });

  it("--ignore never hides failures it was not asked about", async () => {
    const r = await run({ nodeVersion: "v18.0.0" }, {}, { bail: true, ignore: ["ollama-exposed"] });
    expect(r.bailed).toBe(true);
    expect(r.findings.at(-1)!.id).toBe("node-version");
  });
});

describe("--probe (real loads)", () => {
  const chat = (result: any) => route("/api/chat", result, "POST");
  const psAt = (size: number, vram: number) => route("/api/ps", { ok: true, status: 200, json: { models: [{ name: "gemma4:26b", size, size_vram: vram }] } });
  const judgeUp = { "GET http://127.0.0.1:11435/api/version": { ok: true, status: 200, json: {} }, "POST http://127.0.0.1:11435/api/chat": { ok: true, status: 200, json: {} }, "GET http://127.0.0.1:11435/api/tags": { ok: true, status: 200, json: { models: [{ name: "jev:latest", size: 4 * GiB }] } } };
  const ok200 = { ok: true, status: 200, json: { message: {} } };

  it("confirms a model that loads 100% on the GPU and drops any suggestion", async () => {
    const r = await run({ routes: { ...chat(ok200), ...psAt(20 * GiB, 20 * GiB), ...judgeUp } }, {}, { probe: true });
    expect(levelOf(r, "probe-narrator")).toBe("ok");
    expect(levelOf(r, "probe-judge")).toBe("ok");
    expect(r.suggestion).toBeUndefined();
  });

  it("fails when the model cannot be loaded", async () => {
    expect(levelOf(await run({ routes: chat({ ok: false, status: 500, json: { error: "out of memory" } }) }, {}, { probe: true }), "probe-narrator")).toBe("fail");
    expect(levelOf(await run({ routes: chat(null) }, {}, { probe: true }), "probe-narrator")).toBe("fail");
  });

  it("is informational when /api/ps does not show the split", async () => {
    const r = await run({ routes: { ...chat(ok200), ...route("/api/ps", { ok: true, status: 200, json: { models: [] } }) } }, {}, { probe: true });
    expect(levelOf(r, "probe-narrator")).toBe("info");
  });

  it("searches downwards for a context that really fits, and suggests it", async () => {
    // Every load reports 40% on CPU until the context drops to 20480 or less (found on the third try).
    const sys = makeSys({ routes: { ...chat(ok200), ...judgeUp } });
    let lastCtx = 0;
    const baseHttp = sys.http;
    sys.http = async (url, init) => {
      if (url.endsWith("/api/chat") && url.startsWith(BASE)) lastCtx = (init!.body as any).options.num_ctx;
      if (url === `${BASE}/api/ps`) return { ok: true, status: 200, json: { models: [{ name: "gemma4:26b", size: 25 * GiB, size_vram: lastCtx <= 20480 ? 25 * GiB : 15 * GiB }] } };
      return baseHttp(url, init);
    };
    const r = await runDoctor(sys, makeSettings(), { probe: true });
    expect(levelOf(r, "probe-narrator")).toBe("warn");
    const v = find(r, "probe-ctx")!;
    expect(v.level).toBe("ok");
    expect(v.title).toContain("context 20480 loads");
    expect(v.detail).toContain("24576: 40% on CPU");
    expect(r.suggestion!.contextLength).toBe(20480);
  });

  it("warns when no context at or above the game's minimum fits", async () => {
    const r = await run({ routes: { ...chat(ok200), ...psAt(30 * GiB, 10 * GiB) } }, {}, { probe: true });
    expect(levelOf(r, "probe-ctx")).toBe("warn");
  });

  it("warns without searching when the estimate is already below the minimum", async () => {
    const r = await run({ serveEnv: { OLLAMA_CONTEXT_LENGTH: "8400" }, routes: { ...chat(ok200), ...psAt(30 * GiB, 10 * GiB) } }, {}, { probe: true });
    expect(find(r, "probe-ctx")!.detail).toContain("nothing");
  });

  it("probes an OpenAI-compatible narrator and skips a judge that is not running", async () => {
    const openai = { ...route("/api/version", null), [`GET ${BASE}/v1/models`]: { ok: true, status: 200, json: { data: [{ id: "gemma4:26b" }] } }, [`POST ${BASE}/v1/chat/completions`]: { ok: true, status: 200, json: {} } };
    const r = await run({ routes: openai }, {}, { probe: true });
    expect(levelOf(r, "probe-narrator")).toBe("ok");
    expect(levelOf(r, "probe-judge")).toBe("info");
    const bad = await run({ routes: { ...openai, [`POST ${BASE}/v1/chat/completions`]: { ok: false, status: 500, json: {} } } }, {}, { probe: true });
    expect(levelOf(bad, "probe-narrator")).toBe("fail");
    const down = await run({ routes: { ...openai, [`POST ${BASE}/v1/chat/completions`]: null } }, {}, { probe: true });
    expect(find(down, "probe-narrator")!.detail).toBe("no connection");
  });

  it("fails the judge probe when its server answers with an error", async () => {
    const r = await run({ routes: { ...chat(ok200), ...psAt(20 * GiB, 20 * GiB), ...judgeUp, "POST http://127.0.0.1:11435/api/chat": { ok: true, status: 200, json: { error: "model not found" } } } }, {}, { probe: true });
    expect(levelOf(r, "probe-judge")).toBe("fail");
    const refused = await run({ routes: { ...chat(ok200), ...psAt(20 * GiB, 20 * GiB), ...judgeUp, "POST http://127.0.0.1:11435/api/chat": null } }, {}, { probe: true });
    expect(find(refused, "probe-judge")!.detail).toBe("no connection");
  });

  it("probes a judge that shares the narrator's server", async () => {
    const r = await run({ routes: { ...chat(ok200), ...psAt(20 * GiB, 20 * GiB) } }, { judgeInstance: null }, { probe: true });
    expect(levelOf(r, "probe-judge")).toBe("ok");
  });
});
