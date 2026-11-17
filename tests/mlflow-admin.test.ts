import { describe, it, expect } from "@jest/globals";
import { experimentName, getOrCreateExperiment, startRun, logBatch, endRun, putText, promptVersions, MlflowError } from "../src/utils/mlflow-admin.js";
import type { Admin } from "../src/utils/mlflow-admin.js";

type Call = { method: string; url: string; body?: any };
const fake = (replies: Array<{ status?: number; json?: unknown; text?: string }>) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ method: init.method, url, body: init.body && init.headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body });
    const r = replies.shift() ?? { json: {} };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text ?? JSON.stringify(r.json ?? {}) };
  }) as unknown as typeof fetch;
  const admin: Admin = { uri: "http://mlflow:5000/", token: "t", fetch: f };
  return { calls, admin };
};

describe("experimentName", () => {
  it("is model, local date-time, T, time zone, session", () => {
    expect(experimentName({ model: "gemma4:26b", session: "chat:abc", at: new Date("2026-05-28T18:30:15Z"), tz: "America/Toronto" })).toBe("gemma4_26b-2026-05-28-143015-T-America-Toronto-chat_abc");
    expect(experimentName({ model: "m", session: "s", at: new Date("2026-01-01T00:00:00Z"), tz: "UTC" })).toBe("m-2026-01-01-000000-T-UTC-s");
    expect(experimentName({ model: "m", session: "s" })).toMatch(/^m-\d{4}-\d\d-\d\d-\d{6}-T-.+-s$/);
  });
});

describe("experiments and runs", () => {
  it("returns an existing experiment, creates a missing one, and recovers from a lost race", async () => {
    const a = fake([{ json: { experiment: { experiment_id: "7" } } }]);
    expect(await getOrCreateExperiment(a.admin, "x")).toBe("7");
    expect(a.calls[0].url).toBe("http://mlflow:5000/api/2.0/mlflow/experiments/get-by-name?experiment_name=x");
    const b = fake([{ status: 404, json: { error_code: "RESOURCE_DOES_NOT_EXIST" } }, { json: { experiment_id: "9" } }]);
    expect(await getOrCreateExperiment(b.admin, "y")).toBe("9");
    expect(b.calls[1]).toMatchObject({ method: "POST", body: { name: "y" } });
    const c = fake([{ status: 404, json: { error_code: "RESOURCE_DOES_NOT_EXIST" } }, { status: 400, json: { error_code: "RESOURCE_ALREADY_EXISTS" } }, { json: { experiment: { experiment_id: "11" } } }]);
    expect(await getOrCreateExperiment(c.admin, "z")).toBe("11");
    const d = fake([{ status: 500, text: "boom" }]);
    await expect(getOrCreateExperiment(d.admin, "w")).rejects.toBeInstanceOf(MlflowError);
  });
  it("starts, logs and ends a run, and puts text artifacts", async () => {
    const a = fake([{ json: { run: { info: { run_id: "r1" } } } }, {}, {}, { json: {} }, { json: {} }]);
    expect(await startRun(a.admin, "7", "case", { k: "v" })).toBe("r1");
    await logBatch(a.admin, "r1", { params: { m: "gemma" }, metrics: { pass: 2 }, tags: { t: "x".repeat(9000) } });
    await endRun(a.admin, "r1", "FAILED");
    expect(a.calls[1].body.params).toEqual([{ key: "m", value: "gemma" }]);
    expect(a.calls[1].body.tags[0].value).toHaveLength(5000);
    expect(a.calls[2].body).toMatchObject({ run_id: "r1", status: "FAILED" });
    expect(await putText(a.admin, "7", "r1", "out.txt", "hi")).toBe(true);
    expect(a.calls[3]).toMatchObject({ method: "PUT", body: "hi" });
    expect(await putText({ uri: "http://x", fetch: (async () => { throw new Error("down"); }) as any }, "7", "r1", "o", "t")).toBe(false);
  });
});

describe("promptVersions", () => {
  it("lists versions newest first with their text, empty when unknown", async () => {
    const tag = (k: string, value: string) => ({ key: k, value });
    const a = fake([{ json: { model_versions: [{ version: "1", tags: [tag("mlflow.prompt.text", "old")] }, { version: "3", tags: [tag("mlflow.prompt.text", "new")] }] } }]);
    expect(await promptVersions(a.admin, "O'Neil")).toEqual([{ version: 3, text: "new" }, { version: 1, text: "old" }]);
    expect(decodeURIComponent(a.calls[0].url.replace(/\+/g, " "))).toContain("O''Neil");
    expect(await promptVersions(fake([{ status: 404, text: "no" }]).admin, "x")).toEqual([]);
  });
});
