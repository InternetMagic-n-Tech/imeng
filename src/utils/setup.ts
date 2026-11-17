import { ACTOR_TEMPLATE, SETUP_TURNS, SETUP_HINT, USER_ID, NPC_PREFIX, PLACEHOLDER_RES, PROMPTS, SYSTEM_PROMPT } from "./config.js";
import { clone, contentText, norm, flat, untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { judgeJSON } from "./judge.js";
import type { Actor, ChatMessage, GameState } from "./types.js";

// Setup analysis: on the first few turns the judge reads the user's opening messages and records
// session rules and the cast (the user's character, plus NPCs unless a real person controls them).

const DEFAULT_SETUP_PROMPT = `You read the opening messages of a user starting an interactive game or story session with a narrator. Extract:
1. "rules": standing rules the opening messages establish for the whole session (game mode, tone, constraints, who controls which characters, anything that should keep holding).
2. "actors": the user's own character and every other character mentioned.

Guidance:
- The person writing the USER messages is the user's own character (is_user: true). Use "name" only for a real proper name; leave it "" if they gave none. Put what they say about themselves in "description".
- Any other character the user mentions or describes is an NPC controlled by the narrator ("controlled_by":"npc"), even when described as part of the user's team, family or party. Use "other_player" ONLY if the user explicitly says another real person controls that character. "relationship" says how they relate to the user's character.
- For an unnamed non-user character, give "name" as a short label such as "wizard girlfriend".
- Only record what the messages state or clearly imply. Never invent. Every item needs "evidence": a short EXACT quote copied from the USER messages (use "..." to skip words).
- A message that merely names or starts the game (such as "Play X" or "Imeng: X") contains no character or rule information: return empty lists for it. Never write placeholder text such as "to be defined" or "unknown"; if you have nothing real to say, omit the item.
- Items already recorded are listed below: do not repeat them; include an actor again only to add new details.
- If nothing new, return {"rules":[],"actors":[]}.
- Be terse: descriptions and relationships max 15 words, no preamble.

Output ONLY JSON:
{"rules":[{"text":"...","evidence":"..."}],
 "actors":[{"name":"...","is_user":false,"controlled_by":"npc","description":"...","relationship":"...","evidence":"..."}]}`;

const BUILTIN_PLACEHOLDER = /\b(to be (defined|determined|decided|specified)|not (yet )?(specified|provided|defined|given|known|available)|(no|without) (further |more |additional )?(details?|information|info|description)|(yet|still) (to be )?(unknown|undefined|unspecified)|unknown|unspecified|n\/a|tbd)\b/i;
/** Placeholder text ("to be defined", "unknown"...) the judge must not record; games can add patterns (other languages). */
export const isPlaceholder = (t: string): boolean => BUILTIN_PLACEHOLDER.test(t) || PLACEHOLDER_RES.some((r) => r.test(t));

/**
 * The message that starts a game ("Imeng: Dungeon Adventure") carries no information about the player;
 * if the model "quotes" it as evidence, it is echoing the trigger sentence from the system prompt, not
 * reporting anything the player said. Whatever description it hangs on that is invented.
 */
export function echoesTrigger(evidence: unknown, prompt: string = SYSTEM_PROMPT): boolean {
  if (typeof evidence !== "string") return false;
  const parts = evidence.split(/\.{2,}|\u2026/).map(flat).filter(Boolean);
  const head = flat(prompt.slice(0, 1500));
  return parts.length > 0 && parts.every((p) => head.includes(p));
}

/** Evidence must really appear in what the user wrote ("..." may skip words). */
export function evidenceIn(evidence: unknown, userText: string): boolean {
  if (typeof evidence !== "string") return false;
  const parts = evidence.split(/\.{2,}|…/).map(flat).filter(Boolean);
  const hay = flat(userText);
  return parts.length > 0 && parts.some((p) => p.length >= 8) && parts.every((p) => hay.includes(p));
}

interface SetupActor {
  name?: string;
  is_user?: boolean;
  controlled_by?: string;
  description?: string;
  relationship?: string;
  evidence?: string;
}
interface SetupRule { text?: string; evidence?: string }
interface SetupResult { actors?: SetupActor[]; rules?: SetupRule[] }

export function applySetup(state: GameState, result: SetupResult | null | undefined, turn: number, userText = ""): GameState {
  const next = clone(state);
  const hasEvidence = (x: { evidence?: unknown } | undefined): boolean => evidenceIn(x?.evidence, userText) && !echoesTrigger(x?.evidence);
  let added = 0;

  for (const a of Array.isArray(result?.actors) ? result!.actors! : []) {
    if (!hasEvidence(a)) continue;
    const name = String(a.name || "").trim();
    const isUser = a.is_user === true || a.controlled_by === "user";
    if (isUser) {
      const u = next.actors[USER_ID];
      if (name) u.name = name;
      if (a.description && !isPlaceholder(a.description)) u.description = String(a.description).trim();
      added++;
      continue;
    }
    if (!name) continue;
    if (norm(name) === norm(next.actors[USER_ID].name)) continue;
    const existing = Object.values(next.actors).find((x) => x !== next.actors[USER_ID] && norm(x.name || "") === norm(name));
    const fields: Record<string, string | undefined> = {
      description: a.description && !isPlaceholder(a.description) ? String(a.description).trim() : undefined,
      relationship: a.relationship && !isPlaceholder(a.relationship) ? String(a.relationship).trim() : undefined,
    };
    if (existing) {
      for (const [k, v] of Object.entries(fields)) if (v) existing[k] = v;
    } else {
      let n = 0;
      while (next.actors[`${NPC_PREFIX}${n}`]) n++;
      next.actors[`${NPC_PREFIX}${n}`] = {
        ...clone(ACTOR_TEMPLATE), name,
        controlled_by: a.controlled_by === "other_player" ? "other_player" : "npc",
        ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v)),
      } as Actor;
    }
    added++;
  }

  const known = new Set(Object.values(next.game.rules).map((r) => norm(r.text)));
  for (const r of (Array.isArray(result?.rules) ? result!.rules! : []).slice(0, 8)) {
    const text = String(r?.text || "").trim();
    if (!text || isPlaceholder(text) || !hasEvidence(r) || known.has(norm(text))) continue;
    let n = Object.keys(next.game.rules).length;
    while (next.game.rules[`setup_${n}`]) n++;
    next.game.rules[`setup_${n}`] = {
      text, locked: false, lift_hint: "", active: true, lift_votes: 0, source: "setup", turn_added: turn,
    };
    known.add(norm(text));
    added++;
  }
  if (added) console.log(`setup analysis (turn ${turn}): ${added} item(s) recorded`);
  return next;
}

/** True while the session is still within its setup window. */
export const inSetupWindow = (turn: number): boolean => turn <= SETUP_TURNS;

export async function analyzeSetup(state: GameState, messages: ChatMessage[], narration: string, turn: number): Promise<GameState> {
  const convo: string[] = [], userMsgs: string[] = [];
  let users = 0;
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") { if (++users > SETUP_TURNS) break; convo.push(`USER: <player_message>${untrusted(contentText(m.content))}</player_message>`); userMsgs.push(contentText(m.content)); }
    else convo.push(`NARRATOR: <narration>${untrusted(contentText(m.content).slice(0, 600))}</narration>`);
  }
  if (narration) convo.push(`NARRATOR: <narration>${untrusted(narration.slice(0, 600))}</narration>`);
  // Only what has been recorded about people and rules, not stats or gear.
  const recorded = {
    actors: Object.fromEntries(Object.entries(state.actors).map(([id, a]) => [id, {
      name: a.name, controlled_by: a.controlled_by, description: a.description, relationship: a.relationship,
    }])),
    rules: Object.values(state.game.rules).map((r) => r.text),
  };
  const sys = `${PROMPTS.setup || DEFAULT_SETUP_PROMPT}\n\n${UNTRUSTED_NOTICE}` + (SETUP_HINT ? `\n\nGame-specific guidance:\n${SETUP_HINT}` : "");
  const content = `ALREADY RECORDED:\n<recorded>${untrusted(JSON.stringify(recorded))}</recorded>\n\nCONVERSATION:\n${convo.join("\n\n")}`;
  return applySetup(state, await judgeJSON(sys, content, "setup_analysis", 500), turn, userMsgs.join("\n"));
}
