import type { Response as ExpressResponse } from "express";
import { dbg } from "./debug.js";
import { UPSTREAM, MODEL, REASONING, HIDE_STATE_ECHO, HIDE_PRIVATE, PRIVATE_ONLY_REPLY, STATE_RULES, USER_ID, NPC_PREFIX, PROMPTS, ALLOWED_VALUES, STICKY_FIELDS, REFS, ID_DOMAINS, FIELD_ACCESS, MULTIPLAYER, GAME_TURN } from "./config.js";
import { untrusted, UNTRUSTED_NOTICE, OutFilter } from "./text.js";
import { logModel, reqCtx } from "./logger.js";
import type { Sink } from "./sink.js";
import { REPAIR } from "./config.js";
import { repairOps } from "./repair.js";
import { eventSpan, stageSpan } from "./mlflow.js";
import { gpuGate } from "./image-lease.js";
import { applyOps } from "./state.js";
import { redactPii } from "./pii.js";
import { resolveRefs } from "./refs.js";
import type { Exchange, GameState } from "./types.js";

// Everything that talks to the main (narrator) model through Ollama's OpenAI-compatible API.

const upstreamHeaders = { "Content-Type": "application/json", Authorization: "Bearer ollama" };

export const post = async (body: unknown): Promise<globalThis.Response> => {
  const log = dbg("upstream"), t0 = Date.now();
  await gpuGate(); // while a picture is being rendered the narrator's model is unloaded: wait for it to be done
  log("POST %s/chat/completions (gate %d ms)", UPSTREAM, Date.now() - t0);
  try { const r = await fetch(`${UPSTREAM}/chat/completions`, { method: "POST", headers: upstreamHeaders, body: JSON.stringify(body) }); log("upstream answered %d after %d ms", r.status, Date.now() - t0); return r; }
  catch (e) { log("upstream FAILED after %d ms: %s", Date.now() - t0, (e as Error).message); throw e; }
};

export type ChatBody = { messages?: unknown; stream?: boolean; [k: string]: unknown };

// ---------- plain pass-through (Open WebUI background tasks) ----------
export async function passthrough(res: ExpressResponse, body: ChatBody): Promise<void> {
  const t0 = Date.now();
  const upstream = await post(body);
  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
  logModel({ role: "background", model: MODEL, prompt: body.messages, response: buf.toString("utf8"), ms: Date.now() - t0 });
}

/** Hand a finished narration to the client (as one piece), after the same state-echo scrubbing a streamed one gets. Returns the text as recorded. */
/** Fixed closing text for this reply (wrap_up.credits_file), once. */
function takeTail(): string {
  const c = reqCtx.getStore();
  const t = c?.tail ?? "";
  if (c) c.tail = undefined;
  return t;
}

export function deliverText(sink: Sink, text: string): string {
  const f = new OutFilter(HIDE_STATE_ECHO, HIDE_PRIVATE);
  let out = f.push(text) + f.end();
  if (f.hid) { const c = reqCtx.getStore(); if (c) c.rawNarration = f.raw; if (!out.trim()) out = PRIVATE_ONLY_REPLY; }
  sink.canned(out + takeTail());
  return out;
}

/** Answer with fixed text, in the shape the client asked for (streamed or not), without calling a model. */
export function cannedReply(res: ExpressResponse, text: string, stream: boolean): void {
  const base = { id: "chatcmpl-server", created: Math.floor(Date.now() / 1000), model: MODEL };
  if (!stream) { res.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }); return; }
  res.set("Content-Type", "text/event-stream");
  const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: "assistant", content: "" }));
  res.write(chunk({ content: text }));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------- relay: forward the response to the client while collecting the text ----------
export async function relay(res: ExpressResponse, body: ChatBody, role = "narrator"): Promise<string> {
  const t0 = Date.now();
  let out = "";
  let error: string | undefined;
  try { out = await relayInner(res, body, role === "narrator"); return out; }
  catch (e) { error = (e as Error).message; throw e; }
  finally { logModel({ role, model: MODEL, prompt: body.messages, response: out, error, ms: Date.now() - t0 }); }
}

async function relayInner(res: ExpressResponse, body: ChatBody, narrator = false): Promise<string> {
  const upstream = await post(body);
  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/json");

  if (!body.stream) {
    const text = await upstream.text();
    try {
      const j = JSON.parse(text);
      const msg = j.choices[0].message;
      if (REASONING !== "show") { delete msg.reasoning; delete msg.reasoning_content; }
      if (narrator && typeof msg.content === "string") {
        const f = new OutFilter(HIDE_STATE_ECHO, HIDE_PRIVATE);
        msg.content = f.push(msg.content) + f.end();
        if (f.hid) { const c = reqCtx.getStore(); if (c) c.rawNarration = f.raw; if (!msg.content.trim()) msg.content = PRIVATE_ONLY_REPLY; }
      }
      const kept = msg.content || "";
      if (narrator && typeof msg.content === "string") msg.content += takeTail();
      const rs = narrator ? reqCtx.getStore()?.piiRestore : undefined;
      if (rs && typeof msg.content === "string") msg.content = rs.push(msg.content) + rs.end();
      res.json(j);

      return kept;
    } catch { res.send(text); return ""; }
  }

  let narration = "", buf = "";
  const dec = new TextDecoder();
  const filter = narrator ? new OutFilter(HIDE_STATE_ECHO, HIDE_PRIVATE) : null;
  let placed = false;
  let last: any;
  const restore = narrator ? reqCtx.getStore()?.piiRestore : undefined;
  // Text the filter was still holding back goes out before the stream finishes.
  const flushTail = (): void => {
    let tail = filter?.end() ?? "";
    if (filter?.hid && !placed && !(narration + tail).trim()) { tail += PRIVATE_ONLY_REPLY; placed = true; } // all of it was private
    if (filter?.hid) { const c = reqCtx.getStore(); if (c) c.rawNarration = filter.raw; }
    narration += tail;
    let out = tail + (narrator ? takeTail() : "");
    if (restore) out = restore.push(out) + restore.end();
    if (!out) return;
    res.write("data: " + JSON.stringify({ ...last, choices: [{ index: 0, delta: { content: out } }] }) + "\n");
  };
  // Forward one SSE line, stripping reasoning (and chunks that become empty) unless REASONING=show.
  const forward = (line: string): void => {
    if (!line.startsWith("data:")) { res.write(line + "\n"); return; }
    if (line.includes("[DONE]")) { flushTail(); res.write(line + "\n"); return; }
    let j: any;
    try { j = JSON.parse(line.slice(5)); } catch { res.write(line + "\n"); return; }
    last = j;
    const choice = j.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      const hadText = typeof delta.content === "string" && delta.content !== "";
      if (filter && typeof delta.content === "string") delta.content = filter.push(delta.content);
      if (choice.finish_reason) flushTail();
      narration += delta.content || "";
      if (restore && typeof delta.content === "string") { delta.content = restore.push(delta.content); if (!delta.content && hadText) delete delta.content; }
      if (REASONING !== "show") { delete delta.reasoning; delete delta.reasoning_content; }
      const bare = !delta.content && !delta.role && !delta.tool_calls && !choice.finish_reason;
      // Drop chunks that carry nothing now: reasoning we hide, or text the filter held back.
      if (bare && (REASONING !== "show" || hadText)) return;
    }
    res.write("data: " + JSON.stringify(j) + "\n");
  };
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() as string;
    lines.forEach(forward);
  }
  if (buf) forward(buf);
  flushTail();
  res.end(); // client is done; state update continues in the background (next request waits on it)
  return narration;
}

/** One plain, non-streaming completion for bookkeeping (thinking off, bounded). Returns the text. */
export async function completeText(messages: unknown[], maxTokens: number, role: string, temperature = 0): Promise<string> {
  const t0 = Date.now();
  dbg("upstream")("%s completion, up to %d tokens", role, maxTokens);
  const r = await post({ model: MODEL, stream: false, temperature, reasoning_effort: "none", max_tokens: maxTokens, messages });
  const j: any = await r.json();
  const text: string = j.choices?.[0]?.message?.content ?? "";
  logModel({ role, model: MODEL, prompt: messages, response: text, ms: Date.now() - t0 });
  return text;
}

/** Like completeText, but asks for a JSON object and parses it. Throws if the answer isn't JSON. */
export async function completeJSON(messages: unknown[], maxTokens: number, role: string): Promise<any> {
  const t0 = Date.now();
  const r = await post({ model: MODEL, stream: false, temperature: 0, reasoning_effort: "none", max_tokens: maxTokens, response_format: { type: "json_object" }, messages });
  const j: any = await r.json();
  const text: string = j.choices?.[0]?.message?.content ?? "";
  logModel({ role, model: MODEL, prompt: messages, response: text, ms: Date.now() - t0 });
  return JSON.parse(text);
}

// ---------- state extraction ----------
const DEFAULT_EXTRACT_PROMPT = `You are a bookkeeping engine for a text game. Given the current state, the player's message and the narration that followed, output ONLY JSON: {"ops":[...]} describing what changed. Output {"ops":[]} if nothing changed.

Ops (paths start with "game" or "actors", dot-separated; an actor path names a field of one actor):
 {"op":"set","path":"actors.${NPC_PREFIX}1.name","value":"Pat"}
 {"op":"inc","path":"actors.${USER_ID}.<number field>","value":-3}
 {"op":"push","path":"actors.${USER_ID}.statuses","value":"drunk"}
 {"op":"remove","path":"actors.${USER_ID}.statuses","value":"drunk"}
 {"op":"add_actor","id":"${NPC_PREFIX}2","value":{"name":"Eve"}}   (generated actor ids: ${NPC_PREFIX}0, ${NPC_PREFIX}1, ...)
 {"op":"exit_actor","id":"${NPC_PREFIX}1","reason":"died"}${GAME_TURN ? `
 {"op":"effect","who":"${USER_ID}","text":"wears the hat backward","turns":3}   (the narration puts something on someone for a number of game turns)` : ""}
The person typing is always actors.${USER_ID}: record what they say about themselves there (set its fields) and never add an actor for them. Set game.current_actor to the id of the actor whose turn is next, if turns matter. Fields that hold an id (${REFS.map((r) => r.path).join(", ")}) take just the id (e.g. "${USER_ID}", never "actors.${USER_ID}") or null. A value may be the address of another field (e.g. "actors.${NPC_PREFIX}1.score") to copy that field's current value; write an address only when you mean to copy. Record notable actions in that actor's "history" via push. Also push a short one-sentence summary of each significant plot event (who did what to whom, and why it matters) to "game.events". Only record changes that actually happened in the narration.`;

/** The extractor's system prompt (a game may replace it entirely). The untrusted-data notice is always added. */
export const extractPrompt = (): string => `${PROMPTS.extractor || DEFAULT_EXTRACT_PROMPT}\n\n${UNTRUSTED_NOTICE}`;

async function callExtractor(sys: string, content: string): Promise<unknown> {
  const tStart = Date.now();
  const messages = [{ role: "system", content: sys }, { role: "user", content }];
  // Bookkeeping must never "think": on a thinking model (Gemma, Qwen3...) the hidden reasoning is slow
  // (measured: one call took 115 s and came back empty, versus 0.9 s with reasoning off), so switch it
  // off and bound the answer.
  const r = await post({ model: MODEL, stream: false, temperature: 0, reasoning_effort: "none", max_tokens: 2000, response_format: { type: "json_object" }, messages });
  const j: any = await r.json();
  const raw: string = j.choices?.[0]?.message?.content ?? JSON.stringify(j);
  logModel({ role: "extractor", model: MODEL, prompt: messages, response: raw, ms: Date.now() - tStart });
  return coerceOps(JSON.parse(raw));
}

/** Small models often wrap the ops badly: a JSON string, one bare op, or a top-level array. Unwrap those; anything else stays invalid (the retry tells the model). */
export function coerceOps(parsed: unknown): unknown {
  let ops: unknown = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown } | null)?.ops;
  if (typeof ops === "string") { try { ops = JSON.parse(ops); } catch { return ops; } }
  if (ops && typeof ops === "object" && !Array.isArray(ops)) {
    const o = ops as { ops?: unknown; op?: unknown };
    return Array.isArray(o.ops) ? o.ops : typeof o.op === "string" ? [ops] : ops;
  }
  return ops;
}

/**
 * Up to 3 attempts; on a parse failure or fully-rejected ops, tell the model what went wrong.
 * Throws if no attempt produced usable ops (caller keeps the exchange as "unsynced").
 */
/** What the game's field settings mean for the extractor: the values a field accepts and the fields that change only when repeated. */
export function fieldRules(): string {
  const lines: string[] = [];
  const allowed = Object.entries(ALLOWED_VALUES);
  if (allowed.length) lines.push("Some fields accept only these values (anything else is rejected, so pick the closest listed one):", ...allowed.map(([f, v]) => `- ${f}: ${v.map((x) => JSON.stringify(x)).join(", ")}`));
  const sticky = Object.entries(STICKY_FIELDS);
  if (sticky.length) lines.push("Some fields change only when you set the same new value on that many turns in a row (game.pending shows a change that is waiting). Set a new value only when the narration says it really changed, and again on the next turn only while it still says so:", ...sticky.map(([f, n]) => `- ${f}: ${n} turns in a row`));
  const doms = Object.values(ID_DOMAINS).filter((d) => d.name !== "actors");
  if (doms.length) lines.push("Other things have ids too. The server makes each id: add one with an op, then read its id in the state. Refer to entries by id.", ...doms.map((d) => `- ${d.name} (${d.at.join(".")}): {"op":"add","domain":"${d.name}","value":{"${d.from}":"..."}} creates one, {"op":"drop","domain":"${d.name}","id":"<id>"} removes one (everything pointing at it is cleared); change a field with set on ${d.at.join(".")}.<id>.<field>`));
  const refLines = REFS.filter((r) => r.path !== "game.current_actor").map((r) => `- ${r.path}: ${r.keysTo ? `a map whose keys are ${r.keysTo} ids` : `${r.to} id${r.repeat ? " (repeats allowed)" : ""}`}`);
  if (refLines.length) lines.push("These fields hold ids and refuse anything else:", ...refLines);
  const ro = Object.entries(FIELD_ACCESS).filter(([, v]) => v === "read-only").map(([f]) => f);
  if (ro.length) lines.push(`Never write these fields (read-only; you may still copy their value): ${ro.join(", ")}`);
  const wo = Object.entries(FIELD_ACCESS).filter(([, v]) => v === "write-only").map(([f]) => f);
  if (wo.length) lines.push(`These fields can be written but their address must never be used as a value: ${wo.join(", ")}`);
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

/**
 * `early`: the narrator has not replied yet (run alongside it): record only what the player's own message states.
 * `recorded`: that early pass already ran on the newest player message: do not record it twice.
 */
export async function syncState(state: GameState, exchanges: Exchange[], mode?: "early" | "recorded"): Promise<GameState> {
  const sys = extractPrompt() + (STATE_RULES ? `\n\nGame-specific rules:\n${STATE_RULES}` : "") + fieldRules()
    + (MULTIPLAYER ? "\n\nSEVERAL REAL PEOPLE PLAY THIS GAME. Each line of a PLAYER message starts with [Name (actors.<id>)]: that line is that person's own words. What a person says about themselves goes in their own actor (the person typing is NOT always actors." + USER_ID + "). Never add an actor for someone who is already in the state. A line with PRIVATE or NOTE is not something a contestant said: record nothing from it." : "")
    + (mode === "early" ? "\n\nEARLY PASS: the narrator has not replied yet and NARRATION is empty. Record only what the player's own message states (about themselves or anyone in the game). Record nothing that would need the narration to be true." : "")
    + (mode === "recorded" ? "\n\nThe newest PLAYER message was already read once and STATE already holds what it stated: do not record those facts again. Record what the narration adds." : "");
  const base = `STATE:\n<recorded>${untrusted(JSON.stringify(redactPii(state)))}</recorded>\n\n` +
    exchanges.map((e, i) => `EXCHANGE ${i + 1}\nPLAYER:\n<player_message>${untrusted(e.user)}</player_message>\n\nNARRATION:\n<narration>${untrusted(e.narration)}</narration>`).join("\n\n");
  let feedback = "";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    try {
      const ops = await callExtractor(sys, base + feedback);
      const text = exchanges.map((e) => `${e.user}\n${e.narration}`).join("\n");
      const aopts = { untrusted: text, narration: exchanges.map((e) => e.narration).join("\n") };
      let res = applyOps(state, await resolveRefs(state, ops, text), aopts);
      if (REPAIR && res.rejected?.length) { // valid JSON that could not be applied: the judge gets one try at a corrected op, which faces the same checks
        const tR = Date.now();
        try {
          const fixed = await repairOps(res.state, res.rejected, aopts.narration);
          if (fixed.length) {
            const r2 = applyOps(res.state, fixed, aopts);
            res = { ...r2, applied: res.applied + r2.applied, skipped: r2.applied === fixed.length ? [] : [...res.skipped, ...r2.skipped.map((x) => `after repair: ${x}`)] };
          }
          stageSpan(reqCtx.getStore(), "ops.repair", tR, { refused: res.rejected?.length ?? 0, proposed: fixed.length });
        } catch (e) { console.warn("repair judge failed:", (e as Error).message); stageSpan(reqCtx.getStore(), "ops.repair", tR, { failed: true }); }
      }
      stageSpan(reqCtx.getStore(), attempt ? "state.repair" : "state.apply", t0, { "ops.proposed": Array.isArray(ops) ? ops.length : 0, "ops.applied": res.applied, "ops.skipped": res.skipped.length, attempt: attempt + 1 });
      if (res.skipped.length) console.warn("skipped ops:", res.skipped.join(" | "));
      if (res.guarded?.length) console.log("dropped (field_evidence):", res.guarded.join(" | "));
      if ((ops as unknown[]).length === 0 || res.applied > 0 || (res.guarded?.length ?? 0) === (ops as unknown[]).length) return res.state;
      feedback = `\n\nYour previous ops were all rejected: ${res.skipped.join("; ")}. Fix them.`;
      lastErr = new Error("all ops rejected");
    } catch (e) {
      lastErr = e;
      feedback = `\n\nYour previous output was invalid (${(e as Error).message}). Output only {"ops":[...]}.`;
    }
  }
  throw lastErr;
}
