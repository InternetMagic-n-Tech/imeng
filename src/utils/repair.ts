import { judgeJSON } from "./judge.js";
import { judgeView } from "./state.js";
import { PROMPTS } from "./config.js";
import type { GameState, Op } from "./types.js";

/**
 * The data judge. When the extractor's op is valid JSON but cannot be applied (the engine's checks or the imeng's validator refused it), the judge
 * gets one chance to propose a corrected op from the reason and the state. Anything it proposes goes through the same checks again; what still fails
 * is dropped. Off unless config.json has `validate` or `repair: true`. The default prompt below uses real ops, never placeholders (small models copy them).
 */
export interface Rejected { op: unknown; error: string }

const DEFAULT_REPAIR_PROMPT = `You fix bookkeeping changes for a text game. Each change below was refused; the reason is given. Propose a corrected change only when the narration clearly supports a valid one; otherwise omit it. Never invent facts.
Ops: {"op":"set","path":"actors.user.hp","value":12}, {"op":"add_to","path":"actors.user.inventory","value":"rope"}, {"op":"remove_from","path":"actors.user.inventory","value":"rope"}.
Paths must name a field that exists in the state shown. Output ONLY JSON: {"ops":[...]} with at most one corrected op per refused change, or {"ops":[]}.`;

export async function repairOps(state: GameState, rejected: Rejected[], narration: string): Promise<Op[]> {
  if (!rejected.length) return [];
  const paths = new Set(rejected.map((r) => /^actors\.([^.]+)/.exec(String((r.op as Op)?.path ?? ""))?.[1]).filter((x): x is string => !!x));
  const slice = { ...judgeView(state), focus: Object.fromEntries([...paths].map((id) => [id, state.actors[id]])) };
  const v = await judgeJSON(PROMPTS.repair || DEFAULT_REPAIR_PROMPT, `REFUSED CHANGES:\n${JSON.stringify(rejected.slice(0, 8))}\n\nSTATE:\n${JSON.stringify(slice).slice(0, 4000)}\n\nNARRATION:\n${narration.slice(0, 1500)}`, "repair", 300);
  return Array.isArray(v?.ops) ? (v.ops as Op[]).filter((o) => o && typeof o === "object" && typeof o.op === "string").slice(0, rejected.length) : [];
}
