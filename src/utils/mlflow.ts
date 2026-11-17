import crypto from "node:crypto";
import { scrubForLog as clean } from "./pii-filter.js";
import { MLFLOW_ON, MLFLOW_SLOW_MS, MLFLOW_URI, MLFLOW_EXPERIMENT_ID, MLFLOW_RUN_ID, MLFLOW_TOKEN, MLFLOW_CAPTURE, MLFLOW_TIMEOUT_MS, MLFLOW_DEBUG, MODEL_ID, LOG_PROMPT_CHARS } from "./config.js";
import { onShutdown } from "./shutdown.js";
import type { RequestContext } from "./logger.js";

/**
 * MLflow tracing, off unless MLFLOW_TRACKING_URI and MLFLOW_EXPERIMENT_ID are set. One trace per game turn: a root span for the request and
 * a span per model call (narrator, extractor, judge...). Sent as OTLP/JSON to <uri>/v1/traces, which MLflow's server accepts with the
 * x-mlflow-experiment-id header. No dependencies; never lets a failed export touch the game.
 */

type OtlpValue = Record<string, unknown>;
interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: { key: string; value: OtlpValue }[];
  status: { code: number; message?: string };
}
/** The spans of one request, kept on its context until the request ends. */
export interface TraceBuf { traceId: string; rootId: string; spans: OtlpSpan[]; input?: string; output?: string }

const hex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex");
const ns = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const cap = (t: string, n = LOG_PROMPT_CHARS): string => (t.length > n ? t.slice(0, n) + `…[truncated ${t.length - n} chars]` : t);

/** A JS value as an OTLP AnyValue. */
export function otlpValue(v: unknown): OtlpValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(otlpValue) } };
  if (v && typeof v === "object") return { kvlistValue: { values: Object.entries(v).filter(([, x]) => x !== undefined).map(([key, value]) => ({ key, value: otlpValue(value) })) } };
  return { stringValue: String(v ?? "") };
}
const attrs = (o: Record<string, unknown>): OtlpSpan["attributes"] => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([key, value]) => ({ key, value: otlpValue(value) }));

function bufOf(ctx: RequestContext): TraceBuf {
  return (ctx.trace ??= { traceId: hex(16), rootId: hex(8), spans: [] });
}

/** The prompt as chat messages MLflow's UI can show (each capped). */
function asMessages(prompt: unknown): unknown {
  if (Array.isArray(prompt)) return prompt.map((m: any) => ({ role: String(m?.role ?? ""), content: clean(cap(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""), 8000)) }));
  return [{ role: "user", content: clean(cap(typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? ""), 8000)) }];
}
const chars = (prompt: unknown): number => (Array.isArray(prompt) ? prompt.reduce((n: number, m: any) => n + (typeof m?.content === "string" ? m.content.length : JSON.stringify(m?.content ?? "").length), 0) : String(prompt ?? "").length);

/** One finished model call. `ts` is when it ended. */
export function modelSpan(ctx: RequestContext, c: { role: string; model?: string; prompt?: unknown; response?: unknown; ms?: number; error?: unknown; ts: string }): void {
  if (!MLFLOW_ON || ctx.telemetry === false) return;
  const end = Date.parse(c.ts) || Date.now(), ms = Math.max(0, c.ms ?? 0);
  const b = bufOf(ctx);
  const response = typeof c.response === "string" ? c.response : JSON.stringify(c.response ?? "");
  b.spans.push({
    traceId: b.traceId, spanId: hex(8), parentSpanId: b.rootId, name: c.role, kind: 1,
    startTimeUnixNano: ns(end - ms), endTimeUnixNano: ns(end),
    attributes: attrs({
      "mlflow.spanType": "LLM", "mlflow.llm.model": c.model || undefined, "gen_ai.request.model": c.model || undefined,
      "game.role": c.role, "attachment.ids": ctx.attachments?.length ? ctx.attachments.join(",") : undefined, "game.turn": typeof ctx.turn === "number" ? ctx.turn : Number(ctx.turn) || undefined, "game.game_turn": ctx.gameTurn, "game.mode": ctx.mode || undefined,
      "prompt.chars": chars(c.prompt), "response.chars": response.length,
      ...(MLFLOW_CAPTURE === "full" ? { "mlflow.spanInputs": { messages: asMessages(c.prompt) }, "mlflow.spanOutputs": clean(cap(response, 50000)) } : {}),
    }),
    status: c.error ? { code: 2, message: String(c.error).slice(0, 500) } : { code: 1 },
  });
}

/** A moment inside the turn (zero length): what the bookkeeping did, which rule fired... */
export function eventSpan(ctx: RequestContext | undefined, name: string, a: Record<string, unknown>): void {
  if (!MLFLOW_ON || !ctx || ctx.telemetry === false || ctx.mode !== "game") return;
  const b = bufOf(ctx), now = Date.now();
  b.spans.push({
    traceId: b.traceId, spanId: hex(8), parentSpanId: b.rootId, name, kind: 1, startTimeUnixNano: ns(now), endTimeUnixNano: ns(now),
    attributes: attrs({ "mlflow.spanType": "TOOL", "game.turn": typeof ctx.turn === "number" ? ctx.turn : undefined, ...a }), status: { code: 1 },
  });
}

/** A stage with a length (the record repair, a retry, the invocation check...): from `startedAt` to now. A stage slower than MLFLOW_SLOW_MS is marked `bottleneck` so slow turns can be filtered in the MLflow UI. */
export function stageSpan(ctx: RequestContext | undefined, name: string, startedAt: number, a: Record<string, unknown> = {}): void {
  if (!MLFLOW_ON || !ctx || ctx.telemetry === false || ctx.mode !== "game") return;
  const b = bufOf(ctx), now = Date.now(), ms = Math.max(0, now - startedAt);
  b.spans.push({
    traceId: b.traceId, spanId: hex(8), parentSpanId: b.rootId, name, kind: 1, startTimeUnixNano: ns(startedAt), endTimeUnixNano: ns(now),
    attributes: attrs({ "mlflow.spanType": "TOOL", "game.turn": typeof ctx.turn === "number" ? ctx.turn : undefined, "imeng.id": MODEL_ID, ms, bottleneck: ms >= MLFLOW_SLOW_MS, ...a }), status: { code: 1 },
  });
}

/** What the player said and what came back, for the root span (only sent with MLFLOW_CAPTURE=full). */
export function traceIO(ctx: RequestContext | undefined, io: { input?: string; output?: string }): void {
  if (!MLFLOW_ON || !ctx || ctx.telemetry === false || ctx.mode !== "game") return;
  const b = bufOf(ctx);
  if (io.input !== undefined) b.input = io.input;
  if (io.output !== undefined) b.output = io.output;
}

// ---------- sending ----------
const pending = new Set<Promise<void>>();
let lastWarn = 0;

export interface Export { url: string; headers: Record<string, string>; body: string }

/** The request that sends a finished request's spans (null when there is nothing to send). */
export function buildExport(ctx: RequestContext, startedAt: number, failed?: string): Export | null {
  const b = ctx.trace;
  const experiment = ctx.experimentId || MLFLOW_EXPERIMENT_ID;
  if (!MLFLOW_ON || ctx.telemetry === false || !b || !b.spans.length || !experiment) return null;
  const end = Date.now();
  const start = Math.min(startedAt || end, ...b.spans.map((s) => Number(BigInt(s.startTimeUnixNano) / 1_000_000n)));
  const slow = b.spans.reduce((m, x) => { const d = Number((BigInt(x.endTimeUnixNano) - BigInt(x.startTimeUnixNano)) / 1_000_000n); return d > m.ms ? { name: x.name, ms: d } : m; }, { name: "", ms: 0 });
  const root: OtlpSpan = {
    traceId: b.traceId, spanId: b.rootId, name: `turn ${ctx.turn || ""}`.trim(), kind: 1,
    startTimeUnixNano: ns(start), endTimeUnixNano: ns(end),
    attributes: attrs({
      "mlflow.spanType": "CHAIN", "session.id": ctx.session || undefined, "user.id": ctx.user || undefined,
      "mlflow.traceTag.game": MODEL_ID, "mlflow.traceTag.imeng": MODEL_ID, "imeng.id": MODEL_ID, "imeng.slowest": slow.name || undefined, "imeng.slowest_ms": slow.ms || undefined, "mlflow.traceTag.mode": ctx.mode || undefined,
      "game.turn": typeof ctx.turn === "number" ? ctx.turn : undefined, "game.game_turn": ctx.gameTurn, "game.calls": b.spans.length,
      ...(MLFLOW_CAPTURE === "full" ? { "mlflow.spanInputs": b.input === undefined ? undefined : clean(cap(b.input)), "mlflow.spanOutputs": b.output === undefined ? undefined : clean(cap(b.output, 50000)) } : {}),
    }),
    status: failed ? { code: 2, message: failed.slice(0, 500) } : { code: 1 },
  };
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: attrs({ "service.name": "imeng", "game.id": MODEL_ID, "imeng.id": MODEL_ID }) }, scopeSpans: [{ scope: { name: "imeng" }, spans: [root, ...b.spans] }] }] });
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-mlflow-experiment-id": experiment };
  if (MLFLOW_RUN_ID) headers["x-mlflow-run-id"] = MLFLOW_RUN_ID;
  if (MLFLOW_TOKEN) headers.Authorization = `Bearer ${MLFLOW_TOKEN}`;
  return { url: `${MLFLOW_URI}/v1/traces`, headers, body };
}

/** The request is over: send its spans (in the background). */
export function finishTrace(ctx: RequestContext, startedAt: number, failed?: string): void {
  const x = buildExport(ctx, startedAt, failed);
  ctx.trace = undefined;
  if (!x) return;
  const t0 = Date.now();
  const p = (async () => {
    try {
      const r = await fetch(x.url, { method: "POST", headers: x.headers, body: x.body, signal: AbortSignal.timeout(MLFLOW_TIMEOUT_MS) });
      if (MLFLOW_DEBUG) console.log(`[mlflow] sent ${(x.body.length / 1024).toFixed(1)} KB in ${Date.now() - t0} ms: HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      if (Date.now() - lastWarn > 30000) { lastWarn = Date.now(); console.warn("mlflow export failed:", (e as Error).message); }
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Wait for exports in flight (a clean exit, tests). */
export async function flushMlflow(): Promise<void> { await Promise.allSettled([...pending]); }
if (MLFLOW_ON) onShutdown(flushMlflow);
