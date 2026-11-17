import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { casesOf, runCases, recordRun, checkGameDocs, gamesIn, transcript, childSpawner, RESULT_MARK } from "../src/utils/driver-core.js";
import { profileFor } from "../src/utils/run-profile.js";
import type { CaseResult } from "../src/utils/case-run.js";
import type { Admin } from "../src/utils/mlflow-admin.js";

const GAME = path.join(process.cwd(), "tests/fixtures/cases/game");
const result = (over: Partial<CaseResult> = {}): CaseResult => ({ name: "n", game: GAME, model: "m1", steps: [{ who: "Gus", user: "hi", reply: "yo", ms: 5, status: 200 }], outcomes: [{ line: "text: contains yo", ok: true, detail: "1 reply checked" }], state: {}, calls: [{ kind: "narrator", model: "m1", ok: true, ms: 5, messages: 2, system: "sys" }], prompt: "You are the dealer", passed: true, ms: 10, ...over });
const profile = { ...profileFor({}), concurrency: 2, retries: 0 };

describe("runCases", () => {
  it("runs each case for each model and keeps a failed model apart from the others", async () => {
    const seen: string[] = [];
    const runs = await runCases({ files: ["a.md", "b.md"], models: ["m1", "m2"], judgeModel: "j", profile, spawn: async (o) => { seen.push(`${o.file}:${o.model}:${o.judgeModel}`); if (o.model === "m2" && o.file === "b.md") throw new Error("model down"); return result({ model: o.model! }); } });
    expect(seen).toHaveLength(4);
    expect(runs.map((r) => [r.file, r.model, r.result ? "ok" : r.error])).toEqual([["a.md", "m1", "ok"], ["a.md", "m2", "ok"], ["b.md", "m1", "ok"], ["b.md", "m2", "model down"]]);
  });
  it("with no models runs each case once on the default", async () => {
    const runs = await runCases({ files: ["a.md"], models: [], profile, spawn: async () => result({ model: "default-model" }) });
    expect(runs).toEqual([{ file: "a.md", model: "default-model", result: expect.anything() }]);
  });
});

describe("casesOf, gamesIn, checkGameDocs", () => {
  it("finds cases, games and missing docs", () => {
    expect(casesOf(GAME).map((f) => path.basename(f))).toEqual(["one-shot.md"]);
    expect(casesOf("/nope")).toEqual([]);
    expect(gamesIn(path.join(process.cwd(), "imengs")).length).toBeGreaterThanOrEqual(1);
    expect(gamesIn("/nope")).toEqual([]);
    expect(checkGameDocs(GAME).missing).toEqual([]);
    expect(checkGameDocs(os.tmpdir()).missing).toEqual(["VISION.md", "HOW_TO_TEST.md"]);
  });
  it("every shipped game has both mandatory files", () => {
    for (const g of gamesIn(path.join(process.cwd(), "imengs"))) expect(checkGameDocs(g)).toEqual({ game: g, missing: [] });
  });
});

describe("recordRun", () => {
  const tag = (k: string, value: string) => ({ key: k, value });
  const fakeAdmin = (stored: { version: number; text: string }[]) => {
    const calls: { method: string; url: string; body: any }[] = [];
    const f = (async (url: string, init: any) => {
      const u = String(url);
      calls.push({ method: init.method, url: u, body: init.body && init.headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body });
      let json: any = {};
      if (u.includes("get-by-name")) json = { experiment: { experiment_id: "5" } };
      else if (u.includes("runs/create")) json = { run: { info: { run_id: "r9" } } };
      else if (u.includes("model-versions/search")) json = { model_versions: stored.map((s) => ({ version: String(s.version), tags: [tag("mlflow.prompt.text", s.text)] })) };
      return { ok: true, status: 200, text: async () => JSON.stringify(json) };
    }) as unknown as typeof fetch;
    return { calls, admin: { uri: "http://m", fetch: f } as Admin };
  };
  it("records a run with metrics, a transcript, the prompt sent and a matched prompt version", async () => {
    const a = fakeAdmin([{ version: 2, text: "You are the dealer." }]);
    const id = await recordRun({ file: "cases/x.md", model: "m1", result: result() }, { admin: a.admin, experiment: "exp", promptName: "G-SYSTEM_PROMPT.md", promptText: "You are the dealer", judgeModel: "j", compare: ["m2"], forced: true });
    expect(id).toBe("r9");
    const batch = a.calls.find((c) => c.url.endsWith("/runs/log-batch"))!.body;
    expect(batch.metrics.find((m: any) => m.key === "passed").value).toBe(1);
    expect(batch.tags).toEqual(expect.arrayContaining([{ key: "prompt.matched", value: "true" }, { key: "prompt.version", value: "2" }, { key: "model.failed", value: "false" }]));
    expect(batch.params).toEqual(expect.arrayContaining([{ key: "compare_forced", value: "true" }, { key: "judge_model", value: "j" }]));
    const puts = a.calls.filter((c) => c.method === "PUT");
    expect(puts.map((p) => p.url.split("/").pop())).toEqual(["transcript.txt", "prompt-sent.txt"]);
    expect(a.calls.at(-1)!.body.status).toBe("FINISHED");
  });
  it("a prompt that matches no stored version is stored with a diff; a failed model run is marked", async () => {
    const a = fakeAdmin([{ version: 1, text: "You are the dealer, very kind" }]);
    await recordRun({ file: "x.md", model: "m1", result: result({ passed: false, calls: [{ kind: "narrator", model: "m1", ok: false, ms: 1, messages: 1, error: "HTTP 500" }] }) }, { admin: a.admin, experiment: "exp", promptName: "P", promptText: "You are the dealer" });
    const batch = a.calls.find((c) => c.url.endsWith("/runs/log-batch"))!.body;
    expect(batch.tags).toEqual(expect.arrayContaining([{ key: "prompt.matched", value: "false" }, { key: "model.failed", value: "true" }]));
    expect(a.calls.filter((c) => c.method === "PUT").map((p) => p.url.split("/").pop())).toContain("prompt-diff.txt");
    expect(a.calls.at(-1)!.body.status).toBe("FAILED");
  });
  it("a run that never produced a result is recorded as an error", async () => {
    const a = fakeAdmin([]);
    await recordRun({ file: "x.md", model: "m9", error: "exited 1" }, { admin: a.admin, experiment: "e" });
    const batch = a.calls.find((c) => c.url.endsWith("/runs/log-batch"))!.body;
    expect(batch.tags).toEqual(expect.arrayContaining([{ key: "error", value: "exited 1" }, { key: "model.failed", value: "true" }]));
  });
});

describe("transcript and childSpawner", () => {
  it("prints the exchange, the checks and any error", () => {
    const t = transcript(result({ error: "boom", outcomes: [{ line: "x", ok: false, detail: "d" }] }));
    expect(t).toContain("Gus: hi");
    expect(t).toContain("FAIL x (d)");
    expect(t).toContain("ERROR boom");
  });
  it("reads the result line a child prints, and fails clearly when there is none", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-"));
    fs.mkdirSync(path.join(root, "node_modules/vite-node/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/vite-node/dist/cli.mjs"), `console.error("progress"); console.log("noise"); console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify({ name: "n", passed: true, model: process.env.OLLAMA_MODEL }));`);
    const logs: string[] = [];
    expect(await childSpawner(root, (l) => logs.push(l))({ file: "c.md", model: "m7", judgeModel: "j", game: "g" })).toMatchObject({ name: "n", model: "m7" });
    expect(logs).toContain("progress");
    fs.writeFileSync(path.join(root, "node_modules/vite-node/dist/cli.mjs"), "process.exit(3)");
    await expect(childSpawner(root, () => {})({ file: "c.md" })).rejects.toThrow(/exited 3 without a result/);
    fs.writeFileSync(path.join(root, "node_modules/vite-node/dist/cli.mjs"), `console.log(${JSON.stringify(RESULT_MARK)} + "{bad")`);
    await expect(childSpawner(root, () => {})({ file: "c.md" })).rejects.toThrow(/without a result/);
    await expect(childSpawner(path.join(root, "missing"), () => {})({ file: "c.md" })).rejects.toThrow();
  });
});
