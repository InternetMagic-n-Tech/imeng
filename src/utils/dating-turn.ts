import { DATING } from "./config.js";
import { judgeJSON } from "./judge.js";
import { activeActors } from "./conditions.js";
import { crowdFor } from "./audience.js";
import { applyCheck, ageWord, npcPoint, finaleMatch, type Attraction, type Contestant, type Evidence, type Kind } from "./dating.js";
import { untrusted, UNTRUSTED_NOTICE, norm } from "./text.js";
import { stageSpan } from "./mlflow.js";
import { reqCtx } from "./logger.js";
import { revealedTo, storeOf, knownBy } from "./dating-facts.js";
import type { GameState, Session } from "./types.js";

/**
 * One round of the dating show's bookkeeping. A small judge names who warmed or cooled toward whom and must quote the line that shows it; code
 * checks the quote is really in the round, reads the real ages and statuses itself, and moves `game.attraction` by the rules in dating.ts.
 * Narration that merely says someone is smitten is not evidence (the judge is told, and a quote that is only the Host's mood words is dropped).
 */
const PROMPT = `You judge whether anyone in a TV show warmed or cooled toward someone else in this round. Only something a contestant SAID or DID counts, or a fact revealed in the round: never the Host's description of anyone's feelings ("she is smitten") and never your own guess.
For each person who warmed or cooled toward another, give the kind: "interest" (a shared interest or taste: likes cats too), "physical" (a physical or sensory impression: a hug, strength, smell), "passion" (a shared passion: loves skydiving, my favourite thing) or "dislike" (a dislike or a dealbreaker). Give "quote": the exact words from the round that show it.
Output ONLY JSON like {"evidence":[{"from":"bea","to":"bo","kind":"interest","quote":"<the exact words from the round>"}]} using the ids listed, or {"evidence":[]}.`;

const HEARD_RULE = `
Some contestants overheard something about another contestant (listed as OVERHEARD, in pieces). If a contestant then SAYS or DOES something in this round that fits what they heard about someone, then the PERSON THE HEARD FACT IS ABOUT warmed toward the contestant who heard it: "from" is the person the fact is about, "to" is the contestant who heard it and acted on it, kind "interest", and the quote is the exact words the one who acted said in the round (never the overheard words). Example: OVERHEARD says "Mia (heard by Leo): ... loves ... pizza" and the round has Leo saying "pizza night is on me": output {"evidence":[{"from":"mia","to":"leo","kind":"interest","quote":"pizza night is on me"}]}. Only a contestant who heard it counts; if the round does not fit what was heard, output {"evidence":[]}.`;
const KINDS = new Set<Kind>(["interest", "physical", "passion", "dislike"]);
const MOOD = /\b(?:smitten|in love|blushes|blushing|swoons?|crush|falls? for)\b/i;

/** The contestants in play: real age and status read by code, never by a model. */
export function contestants(state: GameState): Contestant[] {
  const D = DATING;
  if (!D) return [];
  const gone = new Set((state.game.exited_game || []).map((e) => e.id));
  return Object.entries(state.actors)
    .filter(([, a]) => a && (a[D.roleField] === undefined || a[D.roleField] === D.contestantRole))
    .map(([id, a]) => ({ id, age: typeof a[D.ageField] === "number" ? (a[D.ageField] as number) : null, status: typeof a[D.statusField] === "string" ? (a[D.statusField] as string) : undefined, left: gone.has(id) }));
}

/** What contestants have overheard about each other (knowledge.overhear fragments and the like): one line per fact that someone other than its subject knows, in pieces as heard. */
export function heardLines(session: Session | undefined, people: Contestant[], state: GameState): string[] {
  const ids = new Set(people.map((p) => p.id)), nm = (id: string): string => String(state.actors[id]?.name || id);
  return (session?.knowledge?.facts ?? []).flatMap((f) => {
    const knowers = f.knownBy.filter((k) => ids.has(k) && k !== f.about);
    return ids.has(f.about) && knowers.length ? [`${nm(f.about)} (heard by ${knowers.map(nm).join(", ")}): ${f.text}`] : [];
  }).slice(-8);
}

/** Edit distance at most 1 (one letter added, dropped or changed). */
const near = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, miss = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++miss > 1) return false; if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; } }
  return miss + (a.length - i) + (b.length - j) <= 1;
};

/** Keep only evidence whose quote is really in the round and is not just the Host describing a mood. */
export function checkEvidence(raw: unknown, text: string, ids: Set<string>, names?: Map<string, string>, heard?: Set<string>): { from: string; to: string; ev: Evidence }[] {
  if (!Array.isArray(raw)) return [];
  const hay = norm(text), res = (x: unknown): string | undefined => (typeof x !== "string" ? undefined : ids.has(x) ? x : names?.get(norm(x)) ?? (() => { const c = [...(names ?? [])].filter(([n]) => n.length >= 3 && near(norm(x), n)); return c.length === 1 ? c[0][1] : undefined; })()); // a small judge often writes the name where the id belongs, or drops a letter of it
  return raw.flatMap((e: any) => {
    const kind = String(e?.kind), quote = String(e?.quote ?? "").trim();
    let from = res(e?.from), to = res(e?.to);
    if (!KINDS.has(kind as Kind) || !from || !to || from === to) return [];
    if (quote.length < 3 || !hay.includes(norm(quote)) || (kind !== "dislike" && MOOD.test(quote))) return [];
    if (kind === "interest" && heard?.has(`${to}>${from}`) && !heard.has(`${from}>${to}`)) [from, to] = [to, from]; // what a contestant overheard about someone warms THAT person toward them, whichever way the judge wrote it
    return [{ from, to, ev: { kind: kind as Kind, quote } }];
  });
}

/** Run the check after a round; returns the state with game.attraction updated. Never throws. */
export async function datingRound(a: { session?: Session; after: GameState; said: string; narration: string }): Promise<GameState> {
  if (!DATING) return a.after;
  const people = contestants(a.after).filter((c) => !c.left);
  if (people.length < 2) return a.after;
  const t0 = Date.now();
  try {
    const names = people.map((p) => `${p.id}: ${String(a.after.actors[p.id]?.name || p.id)} (${ageWord(p)})`).join("\n");
    const text = `${a.said}\n${a.narration}`;
    const st = a.session ? storeOf(a.session) : null;
    const known = st ? st.facts.filter((f) => f.to === "all" || f.to.length).map((f) => `${f.actor} (${f.kind}, learned by ${f.to === "all" ? "everyone" : f.to.join(", ")}): ${f.text}`).join("\n") : "";
    const heard = heardLines(a.session, people, a.after);
    const v = await judgeJSON(`${PROMPT}${heard.length ? HEARD_RULE : ""}\n\n${UNTRUSTED_NOTICE}`, `CONTESTANTS:\n${names}\n${heard.length ? `\nOVERHEARD (what a contestant caught about another, in pieces):\n${untrusted(heard.join("\n"))}\n` : ""}${known ? `\nREVEALED FACTS (the only facts a shared interest or passion may rest on):\n${known}\n` : ""}\nROUND:\n<round>${untrusted(text.slice(0, 5000))}</round>`, "dating", 400);
    const pairs = new Set((a.session?.knowledge?.facts ?? []).flatMap((f) => f.knownBy.filter((k) => k !== f.about).map((k) => `${f.about}>${k}`)));
    let found = checkEvidence(v?.evidence, text, new Set(people.map((p) => p.id)), new Map(people.map((p) => [norm(String(a.after.actors[p.id]?.name || p.id)), p.id])), pairs);
    // A shared interest or passion needs a revealed fact about the person it is felt toward (revealed to the one who feels it): no fact, no step.
    if (st && st.facts.length) found = found.filter((f) => f.ev.kind === "physical" || f.ev.kind === "dislike" || revealedTo(st, f.to, f.from).length > 0 || st.facts.every((x) => x.actor !== f.to));
    let att = ((a.after.game.attraction as Attraction | undefined) ?? {}) as Attraction;
    const byId = new Map(people.map((p) => [p.id, p]));
    const done = new Set<string>(); // one change per pair per check: the first quoted evidence for a pair decides, a dislike first
    let changed = 0;
    for (const f of [...found].sort((x, y) => Number(y.ev.kind === "dislike") - Number(x.ev.kind === "dislike"))) {
      const key = `${f.from}>${f.to}`;
      if (done.has(key)) continue;
      const r = applyCheck(att, byId.get(f.from)!, byId.get(f.to)!, found.filter((x) => x.from === f.from && x.to === f.to).map((x) => x.ev), crowdFor(a.after, f.from));
      done.add(key);
      if (r.changed) { att = r.att; changed++; console.log(`dating: ${f.from} -> ${f.to}: ${r.reason}`); }
    }
    if (changed) a.after.game.attraction = att;
    stageSpan(reqCtx.getStore(), "dating.check", t0, { evidence: found.length, changed });
  } catch (e) { console.warn("dating: the round could not be judged:", (e as Error).message); }
  return a.after;
}

const POINT_PROMPT = `You read a TV show finale. Each real contestant points at ONE other contestant (or at nobody). Using only what the real contestants said or did in the round, say who each of them pointed at.
Output ONLY JSON like {"points":[{"from":"bea","to":"bo"}]} using the ids listed, with "to": null when someone pointed at nobody or it is unclear. List only the real contestants named below.`;

/**
 * The finale: every real contestant points (read by a judge from their own words), every NPC points by code from attraction (ties at random); if two eligible
 * contestants point at each other, both at 2 or 3 toward the other, they are crowned. Runs once, in the finale phase; returns a note for the narrator and
 * records game.royals (a pair, or [] when nobody matched). The Host describes the result, it does not decide it.
 */
export async function finaleRound(state: GameState, said: string): Promise<string> {
  const D = DATING;
  if (!D || state.game.phase !== "finale" || state.game.royals !== undefined) return "";
  const people = contestants(state).filter((p) => !p.left);
  if (people.length < 2) return "";
  const att = ((state.game.attraction as Attraction | undefined) ?? {}) as Attraction;
  const pointing: Record<string, string | null> = {};
  const real = people.filter((p) => state.actors[p.id]?.controlled_by !== "npc");
  try {
    if (real.length) {
      const names = people.map((p) => `${p.id}: ${String(state.actors[p.id]?.name || p.id)}${real.includes(p) ? " (real)" : ""}`).join("\n");
      const v = await judgeJSON(`${POINT_PROMPT}\n\n${UNTRUSTED_NOTICE}`, `CONTESTANTS:\n${names}\n\nROUND:\n<round>${untrusted(said.slice(0, 3000))}</round>`, "dating", 200);
      const ids = new Set(people.map((p) => p.id));
      for (const p of Array.isArray(v?.points) ? v.points : []) if (real.some((r) => r.id === p?.from) && (p.to === null || (typeof p.to === "string" && ids.has(p.to)))) pointing[p.from] = p.to;
    }
  } catch (e) { console.warn("dating: the finale pointing could not be read:", (e as Error).message); }
  for (const p of people) if (!real.includes(p)) pointing[p.id] = npcPoint(att, p.id, people);
  const pair = finaleMatch(att, pointing, people);
  state.game.royals = pair ?? [];
  const nm = (id: string): string => String(state.actors[id]?.name || id);
  console.log(`dating: finale ${pair ? `${pair[0]} and ${pair[1]} are crowned` : "no match"}`);
  const head = "\n\n## FINALE RESULT (decided by the server; describe it, do not change it)\n";
  return head + (pair
    ? (D.finale.pair || "{a} and {b} pointed at each other. Crown them King and Queen and send them to the free dinner on the show. End the show there; no one else is crowned.").replace(/\{a\}/g, nm(pair[0])).replace(/\{b\}/g, nm(pair[1]))
    : D.finale.none || "Nobody pointed at each other, so nobody is crowned. Close the show kindly and warmly, as a feel-good moment for the audience.");
}
