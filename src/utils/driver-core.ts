import fs from "node:fs";
import { gameFolders } from "./game-file.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { runStages } from "./pipeline.js";
import type { Profile } from "./run-profile.js";
import { parseCase } from "./case-file.js";
import type { CaseResult } from "./case-run.js";
import { getOrCreateExperiment, startRun, logBatch, endRun, putText, promptVersions } from "./mlflow-admin.js";
import type { Admin } from "./mlflow-admin.js";
import { matchVersion, unifiedDiff } from "./prompt-match.js";

/* The driver's logic, apart from the command line: finding cases, running one per model in a child process, recording to MLflow, the docs check. */

export const RESULT_MARK = "@@RESULT@@";
export interface Over { state?: string; history?: string; private?: string }
export interface RunOne { file: string; model?: string; judgeModel?: string; game?: string; over?: Over }
export type Spawner = (o: RunOne) => Promise<CaseResult>;

export const casesOf = (game: string): string[] => {
  const dir = path.join(game, "cases");
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(dir, f)); } catch { return []; }
};

/** Run a case in a child process (`driver run-one`), so each model gets a fresh engine and a crash stays contained. */
export const childSpawner = (root: string, log: (l: string) => void = console.log): Spawner => (o) => new Promise((resolve, reject) => {
  const args = [path.join(root, "node_modules/vite-node/dist/cli.mjs"), path.join(root, "scripts/driver.ts"), "run-one", o.file, ...(o.model ? ["--model", o.model] : []), ...(o.judgeModel ? ["--judge-model", o.judgeModel] : []), ...(o.game ? ["--game", o.game] : []), ...(["state", "history", "private"] as const).flatMap((k) => (o.over?.[k] ? [`--${k}`, o.over[k]!] : []))];
  const child = spawn(process.execPath, ["--no-warnings", ...args], { cwd: root, env: { ...process.env, ...(o.model ? { OLLAMA_MODEL: o.model } : {}) } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => log(String(d).trimEnd()));
  child.on("error", reject);
  child.on("close", (code) => {
    const line = out.split("\n").find((l) => l.startsWith(RESULT_MARK));
    if (line) { try { return resolve(JSON.parse(line.slice(RESULT_MARK.length))); } catch { /* fall through */ } }
    reject(new Error(`case process exited ${code} without a result: ${out.slice(-300)}`));
  });
});

export interface RunPlan { files: string[]; models: string[]; judgeModel?: string; game?: string; over?: Over; profile: Profile; spawn: Spawner; log?: (l: string) => void }
export interface Run { file: string; model: string; result?: CaseResult; error?: string }

/** Every case file for every model, as one settled stage: a failed model is recorded and does not stop the others. */
export async function runCases(p: RunPlan): Promise<Run[]> {
  const jobs = p.files.flatMap((file) => (p.models.length ? p.models : [""]).map((model) => ({ file, model })));
  const settled = await runStages([{ name: "cases", opts: { mode: "allSettled", retries: 0 }, tasks: jobs.map((j) => () => p.spawn({ file: j.file, model: j.model || undefined, judgeModel: p.judgeModel, game: p.game, over: p.over })) }], undefined, { profile: p.profile, log: p.log ?? (() => {}) }) as PromiseSettledResult<CaseResult>[];
  return settled.map((s, i): Run => (s.status === "fulfilled" ? { file: jobs[i].file, model: jobs[i].model || s.value.model, result: s.value } : { file: jobs[i].file, model: jobs[i].model, error: (s.reason as Error).message }));
}

export const transcript = (r: CaseResult): string => [`# ${r.name} (${r.model})`, ...r.steps.flatMap((s) => [`${s.who || "Player"}: ${s.user}`, `Host: ${s.reply}`, ""]), ...r.outcomes.map((o) => `${o.ok ? "PASS" : "FAIL"} ${o.line} (${o.detail})`), r.error ? `ERROR ${r.error}` : ""].join("\n");

export interface Record_ { admin: Admin; experiment: string; promptName?: string; promptText?: string; judgeModel?: string; compare?: string[]; forced?: boolean }

/** One MLflow run per case and model: parameters, pass/fail metrics, the transcript, the prompt that reached the model and whether the game's prompt matches a stored version. */
export async function recordRun(r: Run, o: Record_): Promise<string | null> {
  const t0 = Date.now();
  const exp = await getOrCreateExperiment(o.admin, o.experiment);
  const name = `${path.basename(r.file).replace(/\.md$/, "")}-${r.model || "default"}`;
  const run = await startRun(o.admin, exp, name, { "case.file": r.file });
  const res = r.result;
  const tags: Record<string, unknown> = { "case.passed": res ? String(res.passed) : "false", "model.failed": String(!res || !!res.error || res.calls.some((c) => !c.ok)) };
  let diff = "";
  if (o.promptName && o.promptText) {
    const versions = await promptVersions(o.admin, o.promptName);
    const hit = matchVersion(o.promptText, versions);
    tags["prompt.name"] = o.promptName; tags["prompt.matched"] = String(!!hit); if (hit) tags["prompt.version"] = String(hit.version);
    if (!hit && versions[0]?.text) diff = unifiedDiff(versions[0].text, o.promptText) ?? "";
  }
  await logBatch(o.admin, run, {
    params: { model: r.model, judge_model: o.judgeModel ?? "", compare_models: (o.compare ?? []).join(","), compare_forced: o.forced ?? false, game: res?.game ?? "" },
    metrics: res ? { passed: res.passed ? 1 : 0, checks_total: res.outcomes.length, checks_ok: res.outcomes.filter((x) => x.ok).length, ms: res.ms, model_calls: res.calls.length, model_call_failures: res.calls.filter((c) => !c.ok).length } : { passed: 0 },
    tags: { ...tags, ...(r.error ? { error: r.error } : {}) },
  });
  if (res) {
    await putText(o.admin, exp, run, "transcript.txt", transcript(res));
    if (res.prompt) await putText(o.admin, exp, run, "prompt-sent.txt", res.prompt);
    if (diff) await putText(o.admin, exp, run, "prompt-diff.txt", diff);
  }
  await endRun(o.admin, run, res?.passed ? "FINISHED" : "FAILED");
  console.log(`[driver] recorded ${name} in ${Date.now() - t0}ms`);
  return run;
}

export interface DocCheck { game: string; missing: string[] }
/** VISION.md and HOW_TO_TEST.md are mandatory in every game folder. */
export function checkGameDocs(game: string): DocCheck {
  return { game, missing: ["VISION.md", "HOW_TO_TEST.md"].filter((f) => !fs.existsSync(path.join(game, f))) };
}
export const gamesIn = (root: string): string[] => gameFolders(root);
export { parseCase };
