import { MODEL, HIDE_PRIVATE } from "./config.js";
import { visibleText } from "./text.js";
import { post } from "./upstream.js";
import { logModel } from "./logger.js";
import { record, leaksIn, redact } from "./knowledge.js";
import type { KnowledgeConfig } from "./config.js";
import type { Fact, Knowledge } from "./types.js";

/** One narrator call that is not streamed: the reply is held so a leak can be fixed before the table reads it. */
export async function narrateOnce(body: Record<string, unknown>): Promise<string> {
  const t0 = Date.now();
  const r = await post({ ...body, stream: false });
  if (!r.ok) throw new Error(`the model answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = (await r.json() as any).choices?.[0]?.message?.content;
  const out = typeof text === "string" ? text : "";
  logModel({ role: "narrator", model: MODEL, prompt: body.messages, response: out, ms: Date.now() - t0 });
  return out;
}

/** Does the reply hold the leak scan back from streaming? (retry and redact scan before anything is sent) */
export const holdsReply = (cfg: KnowledgeConfig, included: Fact[]): boolean => included.length > 0 && (cfg.leak === "retry" || cfg.leak === "redact");

const notice = (hits: Fact[]): string => `[server notice] Your last reply stated or hinted at something only some people know: ${hits.map((f) => `"${f.text}"`).join("; ")}. Write the reply again without stating it in narration; it may only show in those people's own words and actions, and only if it is their moment. Output only the new reply.`;

/** The leak scan of a narration (facts given to the narrator this round). off: nothing; audit: log; retry: one rewrite, then redact; redact: drop the sentences. */
export async function guardNarration(text: string, a: { cfg: KnowledgeConfig; k: Knowledge; included: Fact[]; turn: number; messages: unknown[]; body: Record<string, unknown> }): Promise<string> {
  const { cfg, k, included, turn } = a;
  if (cfg.leak === "off" || !included.length) return text;
  let hits = leaksIn(included, visibleText(text, HIDE_PRIVATE)); // a watch-word inside <private> is not a leak: the player never reads it
  if (!hits.length) return text;
  for (const f of hits) record(k, cfg, turn, "leak", f.id, cfg.leak);
  if (cfg.leak === "audit") return text;
  if (cfg.leak === "retry") {
    try {
      const again = await narrateOnce({ ...a.body, messages: [...a.messages, { role: "assistant", content: text }, { role: "user", content: notice(hits) }] });
      const h2 = leaksIn(included, visibleText(again, HIDE_PRIVATE));
      if (again.trim() && !h2.length) { for (const f of hits) record(k, cfg, turn, "leak-retried", f.id); return again; }
      if (again.trim()) { text = again; hits = h2; }
    } catch (e) { console.warn("knowledge: rewrite failed:", (e as Error).message); }
  }
  for (const f of hits) record(k, cfg, turn, "leak-redacted", f.id);
  return redact(text, hits);
}
