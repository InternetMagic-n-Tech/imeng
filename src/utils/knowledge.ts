import { announce } from "./announce.js";
import crypto from "node:crypto";
import { flat } from "./text.js";
import type { KnowledgeConfig } from "./config.js";
import type { Fact, GameState, Knowledge, Session } from "./types.js";

/*
 * Facts only some people know (config.json: knowledge; docs/MULTIPLAYER.md section 11). Server-owned store on the table's session, outside every
 * snapshot, never given to the extractor, compactor or any recap. The narrator receives a fact only on a round where one of its knowers speaks or
 * is addressed (access roleplaying); never/dm facts reach no model until they are revealed. Pure functions here; the judge calls are in
 * knowledge-judge.ts, the reply guard in knowledge-turn.ts.
 */

export function storeOf(session: Session, cfg: KnowledgeConfig): Knowledge {
  const k = (session.knowledge ??= { facts: [], pending: {}, audit: [], seq: 0 });
  for (const s of cfg.seed) if (!k.facts.some((f) => f.id === s.id)) k.facts.push(structuredClone(s));
  return k;
}

/** One audit entry: ids and turns, never the text of a fact. */
export function record(k: Knowledge, cfg: KnowledgeConfig, turn: number, kind: string, fact: string, detail?: string): void {
  k.audit.push({ at: Date.now(), turn, kind, fact, detail });
  if (k.audit.length > cfg.auditKeep) k.audit.splice(0, k.audit.length - cfg.auditKeep);
}

export function newId(k: Knowledge): string {
  let id: string;
  do id = `f${++k.seq}`; while (k.facts.some((f) => f.id === id));
  return id;
}

/** Save a fact; an error text when the store is full. */
export function addFact(k: Knowledge, cfg: KnowledgeConfig, f: Fact, turn: number): string | null {
  if (k.facts.length >= cfg.maxFacts) return "The table already holds the most facts it can; forget one first.";
  k.facts.push(f);
  record(k, cfg, turn, "added", f.id, f.access);
  return null;
}

const appears = (text: string, term: string): boolean => { const f = flat(term.replace(/^actors\./, "")); return !!f && ` ${flat(text)} `.includes(` ${f} `); };
const aliases = (term: string, state: GameState): string[] => [term, state.actors[term.replace(/^actors\./, "")]?.name].filter((x): x is string => typeof x === "string" && !!x);

/** Does a knower of the fact speak or get addressed in this round's text? (The round's lines carry each speaker's name and actor id.) */
export const knowersIn = (f: Fact, state: GameState, text: string): boolean => f.knownBy.some((t) => aliases(t, state).some((a) => appears(text, a)));

export interface KBlock { text: string; /** Facts the narrator holds this round that are still hidden. */ included: Fact[]; /** Revealed facts the narrator hears about for the first time. */ announce: Fact[] }

const FOOT = "Never show or quote this block.";
const HIDDEN = `\n\n## SECRET KNOWLEDGE (written by the server; only you see it)\nEach item is known ONLY to the people named. Let it shape their own words, actions and thoughts. Never state it in narration, never let anyone else learn it from you, and if it is not their moment to say it, say nothing of it. ${FOOT}`;
const FRESH = `\n\n## JUST REVEALED (everyone at the table now knows)\nWork each into the story now, and correct anything you said earlier that contradicts it. ${FOOT}`;
const KNOWN = `\n\n## KNOWN TO THE TABLE (revealed earlier)`;

/** What the narrator is told about facts this round. `speaking` (match: judge) overrides the name match with the fact ids the judge found. */
export function blockFor(k: Knowledge, cfg: KnowledgeConfig, state: GameState, roundText: string, speaking?: Set<string>): KBlock {
  let room = cfg.maxChars;
  const take = (f: Fact, line: string): boolean => { if (line.length > room) return false; room -= line.length; return true; };
  const named = (f: Fact): string => f.knownBy.map((t) => state.actors[t.replace(/^actors\./, "")]?.name || t).join(", ");
  const announce: Fact[] = [], included: Fact[] = [];
  let fresh = "", hidden = "", known = "";
  for (const f of k.facts) if (f.revealed && !f.revealed.announced) { const l = `\n- ${f.text}`; if (take(f, l)) { fresh += l; announce.push(f); } }
  for (const f of k.facts) if (!f.revealed && f.access === "roleplaying" && f.knownBy.length && (speaking ? speaking.has(f.id) : knowersIn(f, state, roundText))) { const l = `\n- Known only to ${named(f)}: ${f.text}`; if (take(f, l)) { hidden += l; included.push(f); } }
  for (const f of k.facts) if (f.revealed?.announced) { const l = `\n- ${f.text}`; if (take(f, l)) known += l; }
  return { text: (fresh ? FRESH + fresh : "") + (hidden ? HIDDEN + hidden : "") + (known ? KNOWN + known : ""), included, announce };
}

/** The narrator has now been told: revealed facts are not announced again. */
export const markAnnounced = (facts: Fact[]): void => { for (const f of facts) if (f.revealed) f.revealed.announced = true; };

// ---------- leak scan ----------
const QUOTES = /"[^"]*"|“[^”]*”|«[^»]*»/g;
const fallback = (t: string): string[] => [...new Set(flat(t).split(" ").filter((w) => w.length >= 6))].sort((a, b) => b.length - a.length).slice(0, 3);
export const watchOf = (f: Fact): string[] => (f.watch.length ? f.watch : fallback(f.text));

/**
 * Facts whose give-away words appear in a narration. A fact that can come out by a statement may be spoken by its knower, so quoted speech is
 * not scanned for it (the trigger check handles what was said); everything outside quotes is.
 */
export function leaksIn(facts: Fact[], text: string): Fact[] {
  return facts.filter((f) => { const scan = f.discover.some((d) => d.kind === "statement") ? text.replace(QUOTES, " ") : text; return watchOf(f).some((t) => appears(scan, t)); });
}

/** Drop the sentences that give a fact away. */
export function redact(text: string, hits: Fact[]): string {
  const kept = text.split(/(?<=[.!?…])\s+/).filter((p) => !leaksIn(hits, p).length);
  return kept.length ? kept.join(" ") : "…";
}

/** A turn is being played again (regenerated or edited): what came out on it or later is hidden again. Returns how many. */
export function rollbackKnowledge(k: Knowledge, cfg: KnowledgeConfig, turn: number): number {
  let n = 0;
  for (const f of k.facts) {
    if (f.revealed && f.revealed.turn >= turn) { delete f.revealed; n++; record(k, cfg, turn, "rollback", f.id); }
    if (f.candidate && f.candidate.turn >= turn) delete f.candidate;
  }
  return n;
}

/** The facts a person recorded, that are about their character, or that their character was told, for their own eyes in their private chat. */
export function ownFacts(k: Knowledge, userId: string, actor: string): Fact[] {
  return k.facts.filter((f) => f.createdBy === userId || (f.about === actor && f.createdBy !== "game") || f.knownBy.includes(actor));
}

/** The people (actor ids) who do not know it yet among `to`, then know it: it passes from the sender to them and no further. */
export function passOn(k: Knowledge, cfg: KnowledgeConfig, f: Fact, to: string[], medium: string, turn: number): string[] {
  const added = to.filter((t) => !f.knownBy.includes(t));
  f.knownBy.push(...added);
  if (f.access === "never" && f.knownBy.length) f.access = "roleplaying"; // someone in the story now knows it, so the narrator may be given it when they speak
  if (added.length) record(k, cfg, turn, "transfer", f.id, `to=${added.join(",")} via=${medium}`);
  return added;
}

const PHRASE: Record<string, string> = { whisper: "whispers to", gesture: "makes a quiet gesture to", glance: "exchanges a look with", sign: "signs to", note: "passes a note to", other: "communicates privately with" };

/** The table saw something pass between people, not what: one line for the narrator on the next round (knowledge.notice). */
export function noteSeen(session: Session, cfg: KnowledgeConfig, from: string, to: string[], medium: string): void {
  if (!session.room || !from || !to.length) return;
  const line = `${from} ${PHRASE[medium] ?? PHRASE.other} ${to.join(" and ")}`;
  if (cfg.debrief) { const q = (session.room.debrief ??= { seen: [], npc: [] }); if (!q.seen.includes(line)) q.seen = [...q.seen, line].slice(-10); }
  if (cfg.notice === "seen") (session.room.whispers ??= []).push(line);
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** The fair baseline (knowledge.overhear.traits "roll"): each NPC's nosy and respect fields are rolled once by the server, uniformly 0 to 1, unless the game already gave it a value; then locked (game.locked), so the narrator never chooses them. Returns how many fields were rolled. */
export function rollTraits(state: GameState, cfg: KnowledgeConfig, rng: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000): number {
  const o = cfg.overhear;
  if (!o || o.traits !== "roll") return 0;
  const g = state.game as Record<string, unknown>, locked = (g.locked && typeof g.locked === "object" ? g.locked : {}) as Record<string, true>, exited = Array.isArray(g.exited_game) ? (g.exited_game as { id?: string }[]) : [];
  let n = 0;
  for (const [id, a] of Object.entries(state.actors)) {
    if (id === "table" || a?.controlled_by !== "npc" || exited.some((e) => e?.id === id)) continue;
    for (const f of [o.nosyField, o.respectField]) {
      if (locked[`${id}.${f}`]) continue;
      if (!(Number((a as Record<string, unknown>)[f]) > 0)) { (a as Record<string, unknown>)[f] = Math.round(rng() * 100) / 100; n++; }
      locked[`${id}.${f}`] = true;
    }
  }
  if (n || Object.keys(locked).length) g.locked = locked;
  return n;
}

/** What a listener catches of a whisper: some of its words, in order, never all of them ("I love it when guys love pink" -> "… love … guys … pink"). At least one word. Pure but for `rng`. */
export function fragment(text: string, rng: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000, keep = 0.5): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words[0] ?? "";
  let kept = words.map(() => rng() < keep);
  if (kept.every(Boolean)) kept[Math.floor(rng() * words.length) % words.length] = false;
  if (!kept.some(Boolean)) kept[Math.floor(rng() * words.length) % words.length] = true;
  let out = "", gap = true;
  words.forEach((w, i) => { if (kept[i]) { out += (gap ? "… " : "") + w + " "; gap = false; } else gap = true; });
  return out.trim() + (gap ? " …" : "");
}

/**
 * After a secret dealing passes `f` from `from` to `to` (actor ids): every other character who could witness it (an NPC, or a real player at the table who is not away) always knows that it happened,
 * never exactly what was said. Whether they catch anything is a dice roll by code: knowledge.overhear `base` plus `step` for each point their `nosy_field` (0 to 1) is above their `respect_field`; a
 * character whose nosiness reaches `seek` moves closer on purpose (one more `step`). A hit is a fragment, some of the words (fragment()), kept as its own fact known only to that listener; a real
 * player is told it privately (announce, `overhear.text`). The narrator is told on the next round who saw and who caught what; the table is not.
 */
export async function overhear(session: Session, cfg: KnowledgeConfig, state: GameState, f: Fact, from: string, to: string[], medium: string, turn: number, rng: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000): Promise<string[]> {
  const o = cfg.overhear, room = session.room;
  if (!o || !room) return [];
  const k = storeOf(session, cfg), parties = new Set([from, ...to]), out: string[] = [];
  const nm = (id: string): string => String(state.actors[id]?.name ?? id);
  const exited = Array.isArray((state.game as Record<string, unknown>).exited_game) ? ((state.game as Record<string, unknown>).exited_game as { id?: string }[]) : [];
  const how = `${nm(from)} ${PHRASE[medium] ?? PHRASE.other} ${to.map(nm).join(" and ")}`;
  for (const [id, a] of Object.entries(state.actors)) {
    if (id === "table" || parties.has(id) || exited.some((e) => e?.id === id)) continue;
    const real = a.controlled_by !== "npc" ? Object.values(room.players).find((p) => p.actor === id && !p.away) : undefined;
    if (a.controlled_by !== "npc" && !real) continue;
    const nosy = clamp01(Number((a as Record<string, unknown>)[o.nosyField]) || 0), respect = clamp01(Number((a as Record<string, unknown>)[o.respectField]) || 0);
    const closer = nosy >= o.seek;
    const p = clamp01(o.base + o.step * (nosy - respect) + (closer ? o.step : 0));
    const hit = rng() < p;
    let heard = "";
    if (hit) {
      heard = fragment(f.text, rng);
      const piece: Fact = { id: newId(k), text: heard, about: f.about, knownBy: [id], access: "roleplaying", watch: [], discover: [], createdBy: "game", createdTurn: turn };
      if (addFact(k, cfg, piece, turn)) heard = ""; // the store is full: nothing is kept
    }
    out.push(`${nm(id)} ${closer ? "moved closer to listen and " : ""}${heard ? "caught only a fragment of" : "saw but did not catch"} what ${how}${heard ? ` ("${heard}")` : ""}`);
    record(k, cfg, turn, "overhear", f.id, `by=${id} caught=${!!heard}`);
    if (real && heard) await announce(session, { kind: "overheard", to: real.userId, text: o.text.replace(/\{who\}/g, how).replace(/\{what\}/g, heard) });
    if (cfg.debrief) { const q = (room.debrief ??= { seen: [], npc: [] }); if (!real) q.npc = [...q.npc, heard ? `${nm(id)} gathered: "${heard}"` : `${nm(id)} only saw that ${how}`].slice(-10); }
  }
  if (out.length) (room.overheard ??= []).push(...out);
  return out;
}

/** The producer's beat (knowledge.debrief): ask every real player, privately, what they gathered from what passed in secret since the last beat, and tell the narrator what each NPC witness gathered. Writes nothing about anyone's knowledge. Returns how many people were asked. */
export async function debrief(session: Session, cfg: KnowledgeConfig, turn: number): Promise<number> {
  const d = cfg.debrief, room = session.room, q = room?.debrief;
  if (!d || !room || !q || (!q.seen.length && !q.npc.length)) return 0;
  const fill = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
  let asked = 0;
  if (q.seen.length) for (const p of Object.values(room.players)) { if (p.away) continue; await announce(session, { kind: "debrief", to: p.userId, text: fill(d.ask, { what: q.seen.join("; ") }) }); asked++; }
  if (q.npc.length) (session.pendingEvents ??= []).push({ round: turn, text: fill(d.report, { npc: q.npc.join("; ") }) });
  room.debrief = { seen: [], npc: [] };
  return asked;
}
