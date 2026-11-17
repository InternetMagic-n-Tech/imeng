import { Writable } from "node:stream";
import { dbg } from "./debug.js";
import {
  UPSTREAM, SYSTEM_PROMPT, INVOCATION, JUDGE_MODEL, JUDGE_CONFIRMATIONS, ENFORCE_RULES, AUDIT_WITH_MAIN, JUDGE_INSTANCE, JUDGE_NUM_CTX, JUDGE_URL, JUDGE_API, JUDGE_API_KEY, PRODUCTION, TRIGGER_RE, PROMPTS, JUDGE_LOGGING
} from "./config.js";
import { logModel } from "./logger.js";
import { clone, norm, untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { judgeView } from "./state.js";
import { completeJSON } from "./upstream.js";
import { onKill } from "./shutdown.js";
import { gpuGate } from "./image-lease.js";
import { silentSpawn } from "./spawn-helper.cjs"; // CommonJS helper (typed by spawn-helper.d.cts)
import type { Exchange, GameState, Mode } from "./types.js";
import type { JudgeOver } from "./goals-config.js";

// ---------- the judge model (small, via Ollama's native API) ----------
let judgeBase = JUDGE_URL || UPSTREAM.replace(/\/v1$/, ""); // native Ollama API base

/**
 * Ask the judge model for JSON. Uses the native API so we can set num_ctx and override stop tokens
 * baked into small specialist models' Modelfiles (which would truncate the prompt or the JSON).
 */
export async function judgeJSON(system: string, content: string, role = "judge", maxTokens = 300, over?: JudgeOver): Promise<any> {
  const api = over?.api ?? JUDGE_API, model = over?.model || JUDGE_MODEL, base = over?.url ? over.url.replace(/\/v1$/, "").replace(/\/+$/, "") : judgeBase;
  if (!over?.url && !JUDGE_INSTANCE && !JUDGE_URL && api === "ollama") await gpuGate(); // a judge on the narrator's Ollama must not reload while a picture is rendering
  const tStart = Date.now();
  dbg("judge")("%s call (%s)", role, model);
  const messages = [{ role: "system", content: system }, { role: "user", content }];
  if (api === "openai") return judgeOpenAI(messages, role, maxTokens, tStart, over?.url ? base : undefined, model);
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model, stream: false, format: "json", think: false, keep_alive: JUDGE_INSTANCE || JUDGE_URL || over?.url ? -1 : undefined,
      options: { temperature: 0, num_ctx: over?.numCtx ?? JUDGE_NUM_CTX, num_predict: maxTokens, stop: ["<|judge-no-stop|>"] },
      messages,
    }),
  });
  const j: any = await r.json();
  logModel({ role, model, prompt: messages, response: j.error ? "" : j.message?.content, error: j.error, ms: Date.now() - tStart });
  if (j.error) throw new Error(j.error);
  return JSON.parse(j.message.content);
}

/** The same ask against an OpenAI-compatible server (llama.cpp's llama-server): JSON mode, temperature 0, no reasoning. */
async function judgeOpenAI(messages: { role: string; content: string }[], role: string, maxTokens: number, tStart: number, baseUrl?: string, model = JUDGE_MODEL): Promise<any> {
  const base = (baseUrl || JUDGE_URL || UPSTREAM).replace(/\/v1$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (JUDGE_API_KEY) headers.Authorization = `Bearer ${JUDGE_API_KEY}`;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" }, messages }),
  });
  const j: any = await r.json();
  const text: string = j.choices?.[0]?.message?.content ?? "";
  const error = j.error ? String(j.error.message ?? j.error) : undefined;
  logModel({ role, model, prompt: messages, response: error ? "" : text, error, ms: Date.now() - tStart });
  if (error) throw new Error(error);
  return JSON.parse(text);
}

// ---------- dedicated judge instance (spawned `ollama serve`) ----------
export interface JudgeInstanceResult {
  /** Native API base the judge is reachable at. */
  base: string;
  /** True if this call started the process (false: one was already answering). */
  spawned: boolean;
}

/**
 * Make sure a dedicated judge Ollama is running (spawning `ollama serve` if needed) and point judge
 * calls at it. `opts.host` overrides the listen address (the host-side launcher binds the Docker
 * bridge so containers can reach it). Returns null when no judge_instance is configured or it
 * failed to start.
 */
export async function startJudgeInstance(opts: { host?: string } = {}): Promise<JudgeInstanceResult | null> {
  if (!JUDGE_INSTANCE) return null;
  const port = JUDGE_INSTANCE.port || 11435;
  const host = opts.host || JUDGE_INSTANCE.host || "127.0.0.1";
  const base = `http://${host}:${port}`;
  if (PRODUCTION) { // always-on: nothing is spawned; the judge is expected at JUDGE_URL (or judge_instance's host and port)
    judgeBase = JUDGE_URL || base;
    console.log(`Production: judge expected at ${judgeBase} (not started by this process)`);
    return { base: judgeBase, spawned: false };
  }
  let spawned = false;
  const up = async (): Promise<boolean> => { try { return (await fetch(base + "/api/version")).ok; } catch { return false; } };

  if (!(await up())) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OLLAMA_HOST: `${host}:${port}`,
      OLLAMA_MAX_LOADED_MODELS: "1",
      OLLAMA_NUM_PARALLEL: "1",
      OLLAMA_KEEP_ALIVE: "-1",
      OLLAMA_CONTEXT_LENGTH: String(JUDGE_NUM_CTX),
    };
    const models = JUDGE_INSTANCE.models_dir || process.env.OLLAMA_MODELS;
    if (models) env.OLLAMA_MODELS = models;
    if (JUDGE_INSTANCE.gpu === false) { env.CUDA_VISIBLE_DEVICES = "-1"; env.OLLAMA_VULKAN = "0"; } // Vulkan can still reach the NVIDIA card
    const sink = () => new Writable({ write: (_c, _e, cb) => cb() }); // ollama logs a LOT
    const { child, promise } = silentSpawn("ollama", ["serve"], env, undefined, {},
      { log: () => null, stdout: sink(), stderr: sink() });
    promise.catch((e: Error) => console.warn("judge ollama exited:", e.message));
    const stop = () => child.kill("SIGTERM");
    process.on("exit", stop);
    onKill(stop); // killed instantly on any exit signal
    spawned = true;
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await up())) { console.warn("judge ollama instance failed to start; using main instance"); stop(); return null; }
  }
  judgeBase = base;
  console.log(`Judge instance on ${host}:${port} (${JUDGE_INSTANCE.gpu === false ? "CPU" : "GPU"}, ctx ${JUDGE_NUM_CTX})`);
  // warm the model so the first judgement isn't slow
  fetch(base + "/api/generate", { method: "POST", body: JSON.stringify({ model: JUDGE_MODEL, keep_alive: -1, options: { num_ctx: JUDGE_NUM_CTX } }) })
    .catch((e: Error) => console.warn("judge warmup failed:", e.message));
  return { base, spawned };
}

// ---------- invocation: game mode vs direct mode ----------
// If the system prompt opens with a condition ("If the user's first message is ..."), the judge
// decides whether the user's first message satisfies it. Otherwise: game mode.
const DEFAULT_INVOKE_PROMPT = `Below are the opening lines of instructions for an interactive game narrator. They may state a condition for when they apply, such as an exact phrase the user's first message must be.
Decide whether the user's first message invokes these instructions. Ignore differences in letter case, punctuation and trivial spacing, but a message that does not clearly ask for this game must NOT count (ordinary questions or chat are not invocations).
Be terse. Output ONLY JSON: {"invoked": true|false, "reason": "<max 12 words>"}`;

export async function decideMode(firstMsg: string): Promise<Mode> {
  if (INVOCATION === "always") return "game";
  const head = SYSTEM_PROMPT.slice(0, 1500);
  if (!TRIGGER_RE.test(head)) return "game"; // no condition stated: the prompt always applies
  const msg = firstMsg.trim();
  const quoted = ['"', "'", "“", "‘", "`"].some((q) => norm(head).includes(q + norm(msg)));
  if (msg.length >= 6 && quoted) return "game"; // exact quoted trigger: no model call needed
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = await judgeJSON(`${PROMPTS.invocation || DEFAULT_INVOKE_PROMPT}\n\n${UNTRUSTED_NOTICE}`, `INSTRUCTIONS (opening):\n${head}\n\nUSER'S FIRST MESSAGE:\n<player_message>${untrusted(msg.slice(0, 500))}</player_message>`, "invocation", 100);
      if (typeof v.invoked !== "boolean") throw new Error("no boolean verdict");
      console.log(`invocation check: ${v.invoked ? "game" : "direct"} (${v.reason || "no reason"})`);
      return v.invoked ? "game" : "direct";
    } catch (e) { console.warn("invocation check failed:", (e as Error).message); }
  }
  return "direct";
}

// ---------- session-rule judge ----------
const DEFAULT_JUDGE_PROMPT = `You review standing rules in an ongoing interactive story or game. For each rule decide whether events recorded so far now justify lifting it.
Lift a rule ONLY when recorded events clearly and substantially remove the reason the rule exists, or directly contradict its premise. A lull, a minor event, or a mere change of mood is NOT enough. When unsure, do not lift.
Cite evidence by quoting or closely paraphrasing recorded events or actor history. No evidence means no lift.
Be terse: evidence max 20 words, reason max 12 words, no preamble. Only the recorded events are known to you; do not guess at anything else.
Output ONLY JSON: {"verdicts":[{"id":"<rule id>","lift":true|false,"evidence":"<quote>","reason":"<reason>"}]} with one verdict per rule listed.`;

/** Review open session rules; returns a new state (rules may be lifted after enough consecutive votes). */
export async function judgeRules(state: GameState, exchange: Exchange): Promise<GameState> {
  const open = Object.entries(state.game.rules).filter(([, r]) => r.active && !r.locked);
  if (!open.length) return state;
  const rulesTxt = open.map(([id, r]) => `- id: ${id}\n  rule: ${r.text}` + (r.lift_hint ? `\n  designer note: ${r.lift_hint}` : "")).join("\n");
  const content = `RULES UNDER REVIEW:\n${rulesTxt}\n\nRECORDED STORY SO FAR:\n<recorded>${untrusted(JSON.stringify(judgeView(state)))}</recorded>\n\nLATEST EXCHANGE\nPLAYER:\n<player_message>${untrusted(exchange.user.slice(0, 600))}</player_message>\n\nNARRATION:\n<narration>${untrusted(exchange.narration.slice(0, 1000))}</narration>`;

  let verdicts: any[];
  try {
    if (JUDGE_LOGGING) {
      const judgeSys = `${PROMPTS.rule_judge || DEFAULT_JUDGE_PROMPT}\n\n${UNTRUSTED_NOTICE}`;
      console.log("--- RULE JUDGE INPUT ---");
      console.log("SYSTEM PROMPT:", judgeSys);
      console.log("CONTENT:", content);
      console.log("-----------------------");
    }
    verdicts = (await judgeJSON(`${PROMPTS.rule_judge || DEFAULT_JUDGE_PROMPT}\n\n${UNTRUSTED_NOTICE}`, content, "rule_judge", 120 + 90 * open.length)).verdicts;
    if (!Array.isArray(verdicts)) throw new Error("no verdicts array");
  } catch (e) {
    if (JUDGE_LOGGING) console.error("rule judge error detail:", (e as Error).message);
    console.warn("rule judge failed:", (e as Error).message);
    return state;
  }

  const next = clone(state);
  for (const [id, rule] of open) {
    const v = verdicts.find((x) => x?.id === id);
    const justified = v && v.lift === true && typeof v.evidence === "string" && v.evidence.trim().length > 0;
    const live = next.game.rules[id];
    if (!justified) { live.lift_votes = 0; continue; }
    live.lift_votes += 1;
    live.last_evidence = v.evidence;
    live.last_reason = v.reason || "";
    if (live.lift_votes >= JUDGE_CONFIRMATIONS) {
      live.active = false;
      live.announced = false;
      live.lifted_turn = next.game.turn;
      live.lifted_reason = `${v.reason || "events changed"} (evidence: ${v.evidence})`;
      next.game.events.push(`Rule lifted: ${rule.text}`);
      console.log(`rule lifted [${id}] at turn ${next.game.turn}: ${live.lifted_reason}`);
    }
  }
  return next;
}

// ---------- rule enforcement: audit a reply against the active session rules ----------
const DEFAULT_AUDIT_PROMPT = `You audit one reply of a game narrator against standing rules. Each rule may also be changed for individual people: a person's own entries in the recorded story (any list of rules or preferences in their entry) apply to them in addition to the rules listed, and a person's later statement overrides an earlier one.
Report a violation ONLY when the narration actually does what a rule forbids: it assigns, orders or carries out something that a rule (or that person's own recorded rules) rules out. These are NOT violations: asking a person to choose, offering options that are allowed, describing or mentioning something without assigning it, keeping someone away from it, or excluding it to respect a rule. A rule that applies only to some people says nothing about the others.
Cite the evidence as an EXACT quote copied from the narration (max 25 words). No exact quote means no violation. When unsure, it is not a violation.
Be terse: reason max 15 words. Output ONLY JSON: {"violations":[{"id":"<rule id>","quote":"<exact quote from the narration>","reason":"<reason>"}]}. Use {"violations":[]} when nothing was broken.`;

const DEFAULT_CONFIRM_PROMPT = `You verify one accusation that a game narrator broke a standing rule. You get the rule, the recorded story (who is in the game and each person's own recorded rules), the quote, and the accusation's reason.
Work through it in this order and fill every field:
1. person: who the quote is about (a name from the recorded story), or "" if it is about nobody in particular.
2. their_rule: copy, word for word, the ONE entry from that person's own recorded rules (or the standing rule text) that you say was broken. If none of their recorded rules is about what the quote does, write "".
3. quote_shows: what the quote actually does, in a few words.
4. rule_forbids_it: true only if their_rule really rules out exactly what quote_shows. A rule about one thing says nothing about something else. Offers, questions, mentions and anything not ruled out are false.
5. confirmed: true only if their_rule is not "" and rule_forbids_it is true.
Output ONLY JSON: {"person":"","their_rule":"","quote_shows":"","rule_forbids_it":false,"confirmed":false}`;

export type Violation = { id: string; quote: string; reason: string };

/**
 * Ask the judge whether the narration broke an active session rule. A finding counts only if the rule exists
 * and the quote really is in the narration (so a made-up accusation is dropped). Never throws; returns [] on
 * any doubt. The finding changes no state: the caller feeds it back to the narrator on the next turn.
 */
export async function auditRules(state: GameState, narration: string): Promise<Violation[]> {
  if (!ENFORCE_RULES) return [];
  const active = Object.entries(state.game.rules).filter(([, r]) => r.active);
  if (!active.length) return [];
  const rulesTxt = active.map(([id, r]) => `- id: ${id}\n  rule: ${r.text}`).join("\n");
  const ids = active.map(([id]) => id).join(", ");
  const ask = (sys: string, content: string, tokens: number, role: string): Promise<any> =>
    AUDIT_WITH_MAIN
      ? completeJSON([{ role: "system", content: sys }, { role: "user", content }], tokens, role)
      : judgeJSON(sys, content, role, tokens);
  const view = untrusted(JSON.stringify(judgeView(state)));
  const content = `RULES (the "id" of a violation must be exactly one of: ${ids}):\n${rulesTxt}\n\nRECORDED STORY (background):\n<recorded>${untrusted(JSON.stringify(judgeView(state)))}</recorded>\n\nNARRATION TO AUDIT:\n<narration>${untrusted(narration.slice(0, 4000))}</narration>`;
  try {
    const v = await ask(`${PROMPTS.rule_audit || DEFAULT_AUDIT_PROMPT}\n\n${UNTRUSTED_NOTICE}`, content, 150 + 90 * active.length, "rule_audit");
    if (!Array.isArray(v?.violations)) return [];
    const text = norm(untrusted(narration)); // the judge saw the narration after untrusted()
    const out: Violation[] = [];
    for (const x of v.violations) {
      if (!x || !active.some(([id]) => id === x.id) || typeof x.quote !== "string") continue;
      const q = norm(x.quote);
      if (q.length < 4 || !text.includes(q) || out.some((o) => o.id === x.id)) continue;
      out.push({ id: x.id, quote: x.quote.slice(0, 200), reason: String(x.reason || "").slice(0, 120) });
    }
    // A second look at each accusation, on its own: small and large models both over-flag. Only confirmed ones count.
    const confirmed: Violation[] = [];
    for (const o of out) {
      try {
        const rule = state.game.rules[o.id].text;
        const c = await ask(`${PROMPTS.rule_confirm || DEFAULT_CONFIRM_PROMPT}\n\n${UNTRUSTED_NOTICE}`,
          `RULE:\n${untrusted(rule)}\n\nRECORDED STORY:\n<recorded>${view}</recorded>\n\nQUOTE:\n<narration>${untrusted(o.quote)}</narration>\n\nREASON GIVEN: ${untrusted(o.reason)}`, 200, "rule_confirm");
        // Confirmed only if the model says so AND the rule it cites really exists (in the rule text or the recorded story).
        const cited = typeof c?.their_rule === "string" ? norm(untrusted(c.their_rule)) : "";
        const known = norm(untrusted(rule)) + " " + norm(view);
        if (c?.confirmed === true && c?.rule_forbids_it === true && cited.length >= 4 && known.includes(cited)) confirmed.push(o);
      } catch (e) { console.warn("rule confirm failed:", (e as Error).message); }
    }
    return confirmed;
  } catch (e) {
    console.warn("rule audit failed:", (e as Error).message);
    return [];
  }
}
