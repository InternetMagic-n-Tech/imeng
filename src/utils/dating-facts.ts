import { DATING } from "./config.js";
import { judgeJSON } from "./judge.js";
import { untrusted, UNTRUSTED_NOTICE, norm, flat } from "./text.js";
import type { GameState, Session } from "./types.js";

/**
 * Discovery. Each NPC contestant has private notes (likes, dislikes, passions, favourite colours, values, outfit) written once by a small judge and kept on the
 * session, outside every snapshot. A fact is revealed only when something said or shown in the round reveals it: a judge must quote the line, code checks the
 * quote and flips the flag. Attraction may only use what has been revealed to the person feeling it. The narrator sees an NPC's hidden facts only on a round where
 * that NPC speaks or is addressed, and is told to let them out only through the story.
 */
export type DatingFact = NonNullable<Session["dating"]>["facts"][number];
export type Store = NonNullable<Session["dating"]>;
export const KINDS = ["like", "dislike", "passion", "value", "color", "outfit"] as const;
const MAX_FACTS = 6;

export const storeOf = (s: Session): Store => (s.dating ??= { facts: [], seq: 0 });
export const knownBy = (f: DatingFact, observer: string): boolean => f.to === "all" || f.to.includes(observer) || f.actor === observer;
/** The facts about `actor` that `observer` has learned. */
export const revealedTo = (st: Store, actor: string, observer: string): DatingFact[] => st.facts.filter((f) => f.actor === actor && f.actor !== observer && knownBy(f, observer));

const NOTES_PROMPT = `You write the private notes of one contestant on a beach dating TV show, as fictional traits. Give 3 to 6 short notes, each with a kind: like, dislike, passion, value (for example a political alignment, as a fictional trait), color (a favourite colour) or outfit (head to foot, always with a swimsuit underneath).
Output ONLY JSON like {"notes":[{"kind":"like","text":"cats"},{"kind":"passion","text":"skydiving"},{"kind":"color","text":"pink"},{"kind":"outfit","text":"a straw hat, a blue linen shirt, white shorts, and a red swimsuit underneath"}]}.`;

export async function inventNotes(name: string, about: string): Promise<{ kind: string; text: string }[]> {
  const j = await judgeJSON(NOTES_PROMPT, `CONTESTANT: ${untrusted(name)}${about ? `\nABOUT THEM: ${untrusted(about.slice(0, 400))}` : ""}`, "dating", 400);
  return (Array.isArray(j?.notes) ? j.notes : []).flatMap((n: any) => (KINDS as readonly string[]).includes(n?.kind) && typeof n?.text === "string" && n.text.trim() ? [{ kind: n.kind as string, text: n.text.trim().slice(0, 120) }] : []).slice(0, MAX_FACTS);
}

const npcs = (state: GameState): [string, Record<string, unknown>][] =>
  Object.entries(state.actors).filter(([id, a]) => a && a.controlled_by === "npc" && !(state.game.exited_game || []).some((e) => e.id === id) && (!DATING || a[DATING.roleField] === undefined || a[DATING.roleField] === DATING.contestantRole));

/** Give every NPC contestant who has none a set of private notes. Never throws. */
/** Roll one status from the odds. */
export function rollStatus(odds: Record<string, number>, rng: () => number = Math.random): string {
  const e = Object.entries(odds), total = e.reduce((n, [, v]) => n + v, 0);
  let x = rng() * total;
  for (const [k, v] of e) { x -= v; if (x < 0) return k; }
  return e[e.length - 1]![0];
}

export async function ensureNotes(session: Session, state: GameState, rng: () => number = Math.random): Promise<void> {
  if (!DATING) return;
  const st = storeOf(session);
  for (const [id, a] of npcs(state)) {
    // An NPC's relationship status is rolled once by code and locked (no breakups on live TV); the narrator is told it through the state.
    const locked = (state.game.locked && typeof state.game.locked === "object" ? state.game.locked : {}) as Record<string, true>;
    if (!locked[`${id}.${DATING.statusField}`] && (a[DATING.statusField] === undefined || a[DATING.statusField] === "" || a[DATING.statusField] === "single")) {
      a[DATING.statusField] = rollStatus(DATING.npcStatus, rng);
      state.game.locked = { ...locked, [`${id}.${DATING.statusField}`]: true };
    }
    if (st.facts.some((f) => f.actor === id)) continue;
    try {
      for (const n of await inventNotes(String(a.name || id), typeof a.description === "string" ? a.description : "")) st.facts.push({ id: `d${++st.seq}`, actor: id, kind: n.kind, text: n.text, to: [] });
    } catch (e) { console.warn(`dating: no notes written for ${id}:`, (e as Error).message); }
  }
}

const REVEAL_PROMPT = `You decide which hidden facts about contestants were revealed in this round of a TV show. A fact is revealed only when something said or shown in the round reveals it: the Host's narration, a contestant's own words, or an accident (a gak hit soaking a t-shirt). Never guess.
For each fact revealed, give "id", "to": "all" if it was said or shown openly, or the list of contestant ids who learned it if only some did (a whisper), and "quote": the exact words from the round that reveal it.
Output ONLY JSON like {"reveals":[{"id":"d3","to":"all","quote":"I'm obsessed with skydiving"}]} or {"reveals":[]}.`;

/** Flip the reveal flags the round earns. Returns how many facts were revealed. Never throws. */
export async function revealRound(session: Session, state: GameState, text: string): Promise<number> {
  const st = storeOf(session);
  const hidden = st.facts.filter((f) => f.to !== "all");
  if (!hidden.length) return 0;
  try {
    const ids = new Set(Object.keys(state.actors));
    const list = hidden.map((f) => `${f.id}: ${String(state.actors[f.actor]?.name || f.actor)} (${f.actor}) ${f.kind}: ${f.text}`).join("\n");
    const v = await judgeJSON(`${REVEAL_PROMPT}\n\n${UNTRUSTED_NOTICE}`, `HIDDEN FACTS:\n${list}\n\nROUND:\n<round>${untrusted(text.slice(0, 5000))}</round>`, "dating", 300);
    const hay = norm(text);
    let n = 0;
    for (const r of Array.isArray(v?.reveals) ? v.reveals : []) {
      const f = hidden.find((x) => x.id === r?.id), quote = String(r?.quote ?? "").trim();
      if (!f || quote.length < 3 || !hay.includes(norm(quote))) continue; // no quote in the round, no reveal
      const to = r.to === "all" ? "all" : Array.isArray(r.to) ? r.to.filter((x: unknown): x is string => typeof x === "string" && ids.has(x)) : [];
      if (to !== "all" && !to.length) continue;
      f.to = to === "all" ? "all" : [...new Set([...(f.to === "all" ? [] : f.to), ...to])];
      n++; console.log(`dating: fact ${f.id} revealed`);
    }
    return n;
  } catch (e) { console.warn("dating: the round's reveals could not be judged:", (e as Error).message); return 0; }
}

/** What the narrator is told about NPC contestants who speak or are addressed this round: everything about them, with the rule that hidden facts come out only through the story. */
export function factsBlock(session: Session, state: GameState, roundText: string): string {
  const st = session.dating;
  if (!DATING || !st?.facts.length) return "";
  const round = ` ${flat(roundText)} `;
  const lines: string[] = [];
  for (const [id, a] of npcs(state)) {
    const name = String(a.name || id);
    if (!round.includes(` ${flat(name)} `) && !round.includes(` ${flat(id)} `)) continue;
    const mine = st.facts.filter((f) => f.actor === id);
    if (!mine.length) continue;
    lines.push(`- ${name}: ${mine.map((f) => `${f.kind}: ${f.text}${f.to === "all" ? "" : " (not yet known to the others)"}`).join("; ")}`);
  }
  return lines.length ? `\n\n## PRIVATE NOTES (written by the server; only for contestants who speak or are addressed now)\nLet a hidden fact out only through what the contestant says or does, or an accident in the story; never announce it.\n${lines.join("\n")}` : "";
}
