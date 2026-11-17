import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Case, Message } from "./case-file.js";
import { runChecks } from "./case-checks.js";
import type { Outcome } from "./case-checks.js";

/*
 * Run one case in this process against the real engine: the game's state is seeded, each step is posted as a chat request, then the
 * checks run. IMENG_PATH is set before the engine loads, so one process runs one game (the driver starts a process per game and model).
 * Model calls are noted (model, whether they worked, time) so a failed model shows up and the prompt that produced the reply is known.
 */

export interface ModelCall { kind: "narrator" | "judge"; model: string; ok: boolean; ms: number; error?: string; system?: string; messages: number }
export interface StepResult { who?: string; user: string; reply: string; ms: number; status: number }
export interface CaseResult { name: string; game: string; model: string; steps: StepResult[]; outcomes: Outcome[]; state: unknown; calls: ModelCall[]; prompt: string; passed: boolean; ms: number; error?: string }
export interface RunOpts { judgeModel?: string; log?: (line: string) => void }

const merge = (a: any, b: any): any => {
  if (b === undefined) return a;
  if (!b || typeof b !== "object" || Array.isArray(b) || !a || typeof a !== "object" || Array.isArray(a)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
  return out;
};

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);
const read = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

/** A request to the in-process server, over http directly so it never goes through the (wrapped or faked) model fetch. */
const postJson = (port: number, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
    let raw = ""; res.on("data", (d) => { raw += d; });
    res.on("end", () => { let json: any = {}; try { json = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }); });
  });
  req.on("error", reject); req.end(JSON.stringify(body));
});

export async function runCase(c: Case, opts: RunOpts = {}): Promise<CaseResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const t0 = Date.now();
  process.env.IMENG_PATH = c.game;
  if (!process.env.SAVE_DIR) process.env.SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "driver-saves-")); // a case never writes into the project's saves
  fs.mkdirSync(process.env.SAVE_DIR, { recursive: true });
  if (c.models.narrator) process.env.OLLAMA_MODEL = c.models.narrator;
  const { app } = await import("../app.js");
  const { sessions } = await import("./sessions.js");
  const { initialState } = await import("./state.js");
  const { MODEL, SYSTEM_PROMPT } = await import("./config.js");
  const calls: ModelCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    let body: any = null;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { /* not JSON */ }
    const t = Date.now();
    const kind = String(url).endsWith("/chat/completions") ? "narrator" : "judge";
    try {
      const r = await realFetch(url, init);
      if (body?.messages && body?.model) calls.push({ kind, model: String(body.model ?? ""), ok: r.ok, ms: Date.now() - t, messages: body.messages.length, system: body.messages.find((m: any) => m.role === "system")?.content, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) });
      return r;
    } catch (e) {
      if (body?.messages && body?.model) calls.push({ kind, model: String(body.model ?? ""), ok: false, ms: Date.now() - t, messages: body.messages.length, error: (e as Error).message });
      throw e;
    }
  }) as typeof fetch;
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const key = "chat:" + c.chat;
  const steps: StepResult[] = [];
  const replies: string[] = [];
  let state: unknown = null;
  let error: string | undefined;
  try {
    const turns = c.history.filter((m) => m.role === "user").length;
    const seeded = merge(initialState(), c.state);
    sessions.set(key, { snapshots: Array.from({ length: turns + 1 }, () => structuredClone(seeded)), unsynced: [], gameVersion: null, tail: Promise.resolve() });
    const log_: Message[] = [...c.history];
    const send = async (text: string, who?: string): Promise<StepResult> => {
      log_.push({ role: "user", content: text });
      const t = Date.now();
      const r = await postJson(port, { "x-openwebui-chat-id": c.chat, "x-openwebui-user-id": `case-${(who || "player").toLowerCase()}`, "x-openwebui-user-name": who || "Player" }, { messages: log_ });
      const reply = String(r.json?.choices?.[0]?.message?.content ?? r.json?.error?.message ?? "");
      if (r.status < 400) log_.push({ role: "assistant", content: reply });
      await sessions.get(key)?.tail;
      return { who, user: text, reply, ms: Date.now() - t, status: r.status };
    };
    for (const note of c.private) { const r = await send(`<private>${note}</private>`); log(`  private note: ${cap(r.reply, 80)}`); }
    for (const [i, s] of c.steps.entries()) {
      const r = await send(s.text, s.who);
      steps.push(r); replies.push(r.reply);
      log(`  step ${i + 1}/${c.steps.length}: ${r.status} in ${r.ms}ms`);
      if (r.status >= 400) throw new Error(`step ${i + 1} failed: ${cap(r.reply, 200)}`);
    }
    state = sessions.get(key)?.snapshots.at(-1) ?? null;
  } catch (e) { error = (e as Error).message; state = sessions.get(key)?.snapshots.at(-1) ?? null; }
  finally { server.close(); globalThis.fetch = realFetch; }

  const first = runChecks(c.checks, state, replies);
  const outcomes: Outcome[] = [];
  for (const [i, o] of first.entries()) {
    if (o) { outcomes.push(o); continue; }
    const q = c.checks[i] as { kind: "judge"; question: string; line: string };
    outcomes.push(await judge(q.question, q.line, c, steps, state, opts.judgeModel, SYSTEM_PROMPT, error));
  }
  const mine = SYSTEM_PROMPT.slice(0, 60);
  const lastNarrator = [...calls].reverse().find((x) => x.kind === "narrator" && x.system?.includes(mine));
  const passed = !error && outcomes.every((o) => o.ok);
  return { name: c.name, game: c.game, model: MODEL, steps, outcomes, state, calls, prompt: lastNarrator?.system ?? "", passed, ms: Date.now() - t0, ...(error ? { error } : {}) };
}

async function judge(question: string, line: string, c: Case, steps: StepResult[], state: unknown, model: string | undefined, systemPrompt: string, error?: string): Promise<Outcome> {
  if (error) return { line, ok: false, detail: "not judged: the run failed" };
  const { judgeJSON } = await import("./judge.js");
  const vision = read(path.join(c.game, "VISION.md"));
  const system = 'You check one claim about a play-through of a text game. Reply with JSON only: {"ok": true or false, "why": "one short sentence"}. Judge only from the transcript and state.';
  const content = `GAME VISION:\n${cap(vision, 3000)}\n\nGAME INSTRUCTIONS (the host's prompt):\n${cap(systemPrompt, 4000)}\n\nSTATE AT THE END:\n${cap(JSON.stringify(state), 3000)}\n\nTRANSCRIPT:\n${steps.map((s) => `${s.who || "Player"}: ${s.user}\nHost: ${cap(s.reply, 1500)}`).join("\n\n")}\n\nCLAIM TO CHECK: ${question}`;
  const t = Date.now();
  try {
    const r = await judgeJSON(system, content, "case_judge", 200, model ? { model } : undefined);
    console.log(`[driver] judge "${cap(question, 40)}" in ${Date.now() - t}ms`);
    return { line, ok: r?.ok === true, detail: String(r?.why ?? "") };
  } catch (e) { return { line, ok: false, detail: `judge failed: ${(e as Error).message}` }; }
}
