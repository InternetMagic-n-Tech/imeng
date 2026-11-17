import { judgeJSON } from "./judge.js";
import { RULING, USER_ID } from "./config.js";
import { untrusted, UNTRUSTED_NOTICE, flat } from "./text.js";
import type { GameState } from "./types.js";

/**
 * The magic-play judge (config.json `ruling`). In the named phase a small judge reads what the player tries (a spell cast, an item invoked) and says which
 * spell or item it is and whether the character could do it. The lookup table (class -> spells) is code: a spell the table does not list for the character's
 * class is refused whatever the judge says, and a table that lists it still waits for the judge's yes. The ruling is given to the narrator to describe;
 * a failing judge gives no ruling (the narrator decides, as before).
 */
const PROMPT = `You rule on a magic attempt in a fantasy game. Say which spell or magic item the player is trying to use (its usual name, lowercase), and whether this character could plausibly do it from what they are, carry and have said. Judge only what the character has, not what would be fun.
Output ONLY JSON: {"spell": "name", "allowed": true or false, "reason": "one short sentence"}, or {"spell": "", "allowed": true, "reason": ""} when the message is not a magic attempt.`;

export interface Ruling { spell: string; allowed: boolean; reason: string }

/** The code's lookup: true when the table lists the spell for the class (or there is no table, or no entry for the class: then the judge alone decides). */
export function listed(table: Record<string, string[]> | undefined, cls: string, spell: string): boolean {
  if (!table) return true;
  const key = Object.keys(table).find((k) => flat(k) === flat(cls));
  if (!key) return true;
  return table[key]!.some((s) => flat(s) === flat(spell));
}

export async function rule(state: GameState, said: string, actor = USER_ID): Promise<Ruling | null> {
  const R = RULING;
  if (!R || state.game.phase !== R.phase) return null;
  const a = state.actors[actor];
  if (!a || said.trim().length < 3) return null;
  const cls = String(a[R.field] ?? "");
  const known = R.table && cls ? (R.table[Object.keys(R.table).find((k) => flat(k) === flat(cls)) ?? ""] ?? []) : [];
  try {
    const sheet = `CLASS: ${cls || "unknown"}\nLEVEL: ${String(a.level ?? "?")}\nCARRIES: ${JSON.stringify(a.inventory ?? [])}${known.length ? `\nSPELLS THIS CLASS CAN CAST: ${known.join(", ")}` : ""}${R.question ? `\n${R.question}` : ""}`;
    const v = await judgeJSON(`${PROMPT}\n\n${UNTRUSTED_NOTICE}`, `${sheet}\n\nPLAYER:\n<message>${untrusted(said.slice(0, 1500))}</message>`, "ruling", 120);
    const spell = typeof v?.spell === "string" ? v.spell.trim().toLowerCase().slice(0, 60) : "";
    if (!spell) return null;
    let allowed = v?.allowed === true, reason = typeof v?.reason === "string" ? v.reason.trim().slice(0, 200) : "";
    if (allowed && !listed(R.table, cls, spell)) { allowed = false; reason = `a ${cls} cannot cast ${spell}`; }
    return { spell, allowed, reason };
  } catch { return null; }
}

const line = (r: Ruling, who?: string): string => `${who ? `${who}: ` : ""}${r.spell}: ${r.allowed ? "ALLOWED. It works (at the strength of the card drawn, if any)." : `NOT ALLOWED. It fails or cannot be attempted${r.reason ? `: ${r.reason}` : ""}.`}`;
export const rulingBlock = (r: Ruling | null): string => r ? `\n\n## MAGIC RULING (decided by the server; describe it, do not change it)\n${line(r)}` : "";

/** A table's round: one line per person, `[Name (actors.id)] words`. Each public line is ruled on in turn (at most six); private lines are not. */
export async function ruleRound(state: GameState, roundText: string, by?: Record<string, Ruling>): Promise<string> {
  if (!RULING || state.game.phase !== RULING.phase) return "";
  const out: string[] = [];
  for (const l of roundText.split("\n")) {
    const m = /^\[(.+?) \(actors\.([^)]+)\)\]\s*(.*)$/.exec(l);
    if (!m || /^PRIVATE/.test(m[3]!) || out.length >= 6) continue;
    const r = await rule(state, m[3]!, m[2]!);
    if (r) { out.push(line(r, m[1])); if (by) by[m[2]!] = r; }
  }
  return out.length ? `\n\n## MAGIC RULING (decided by the server; describe it, do not change it)\n${out.join("\n")}` : "";
}
