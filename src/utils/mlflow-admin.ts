/*
 * The parts of MLflow's REST API the driver and per-chat experiments use: experiments (get or create), runs (params, metrics, tags,
 * text artifacts) and stored prompt versions. Every call goes through `io.fetch` so tests use a fake; nothing here is imported by the game turn.
 */

export interface Admin { uri: string; token?: string; fetch?: typeof fetch; timeoutMs?: number }
export class MlflowError extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }

async function api(a: Admin, method: string, route: string, o: { query?: Record<string, string>; body?: unknown } = {}): Promise<any> {
  const q = o.query ? "?" + new URLSearchParams(o.query).toString() : "";
  const r = await (a.fetch ?? fetch)(`${a.uri.replace(/\/+$/, "")}/api/2.0/mlflow${route}${q}`, {
    method, signal: AbortSignal.timeout(a.timeoutMs ?? 10_000),
    headers: { "Content-Type": "application/json", ...(a.token ? { Authorization: `Bearer ${a.token}` } : {}) },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  const text = await r.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!r.ok) throw new MlflowError(j.message || text.slice(0, 200) || `HTTP ${r.status}`, j.error_code || `HTTP_${r.status}`, r.status);
  return j;
}

/** `<model>-2026-05-28-143015-T-America-Toronto-<session>`: the model first, then a human-readable local time stamp. */
export function experimentName(p: { model: string; session: string; at?: Date; tz?: string }): string {
  const tz = p.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(p.at ?? new Date()).map((x) => [x.type, x.value]));
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${clean(p.model)}-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}-T-${clean(tz.replace(/\//g, "-"))}-${clean(p.session)}`;
}

/** The id of the experiment with this name, created when it does not exist. */
export async function getOrCreateExperiment(a: Admin, name: string): Promise<string> {
  const get = async (): Promise<string | null> => {
    try { return (await api(a, "GET", "/experiments/get-by-name", { query: { experiment_name: name } })).experiment?.experiment_id ?? null; }
    catch (e) { if (e instanceof MlflowError && (e.code === "RESOURCE_DOES_NOT_EXIST" || e.status === 404)) return null; throw e; }
  };
  const found = await get();
  if (found) return found;
  try { return String((await api(a, "POST", "/experiments/create", { body: { name } })).experiment_id); }
  catch (e) { if (e instanceof MlflowError && e.code === "RESOURCE_ALREADY_EXISTS") { const again = await get(); if (again) return again; } throw e; }
}

const clip = (s: unknown, n: number): string => String(s ?? "").slice(0, n);

export async function startRun(a: Admin, experimentId: string, runName: string, tags: Record<string, string> = {}): Promise<string> {
  const r = await api(a, "POST", "/runs/create", { body: { experiment_id: experimentId, run_name: runName, start_time: Date.now(), tags: Object.entries(tags).map(([key, value]) => ({ key, value: clip(value, 5000) })) } });
  return r.run.info.run_id;
}
export async function logBatch(a: Admin, runId: string, d: { params?: Record<string, unknown>; metrics?: Record<string, number>; tags?: Record<string, unknown> }): Promise<void> {
  const ts = Date.now();
  await api(a, "POST", "/runs/log-batch", { body: {
    run_id: runId,
    params: Object.entries(d.params ?? {}).map(([key, value]) => ({ key, value: clip(value, 500) })),
    metrics: Object.entries(d.metrics ?? {}).map(([key, value]) => ({ key, value, timestamp: ts, step: 0 })),
    tags: Object.entries(d.tags ?? {}).map(([key, value]) => ({ key, value: clip(value, 5000) })),
  } });
}
export async function endRun(a: Admin, runId: string, status: "FINISHED" | "FAILED" = "FINISHED"): Promise<void> {
  await api(a, "POST", "/runs/update", { body: { run_id: runId, status, end_time: Date.now() } });
}
/** A text artifact, through the artifact proxy (best effort: false when the server has none). */
export async function putText(a: Admin, experimentId: string, runId: string, file: string, text: string): Promise<boolean> {
  try {
    const r = await (a.fetch ?? fetch)(`${a.uri.replace(/\/+$/, "")}/api/2.0/mlflow-artifacts/artifacts/${experimentId}/${runId}/artifacts/${file}`, { method: "PUT", body: text, headers: { "Content-Type": "text/plain", ...(a.token ? { Authorization: `Bearer ${a.token}` } : {}) }, signal: AbortSignal.timeout(a.timeoutMs ?? 10_000) });
    return r.ok;
  } catch { return false; }
}

export interface StoredPrompt { version: number; text?: string }
/** Every stored version of a registered prompt (newest first); empty when there is none. */
export async function promptVersions(a: Admin, name: string): Promise<StoredPrompt[]> {
  const esc = name.replace(/'/g, "''");
  let versions: any[] = [];
  try { versions = (await api(a, "GET", "/model-versions/search", { query: { filter: `name='${esc}' AND tags.\`mlflow.prompt.is_prompt\` = 'true'`, max_results: "200" } })).model_versions ?? []; } catch { /* not found */ }
  return versions.map((v) => ({ version: Number(v.version), text: (v.tags ?? []).find((t: any) => t.key === "mlflow.prompt.text")?.value })).sort((x, y) => y.version - x.version);
}
