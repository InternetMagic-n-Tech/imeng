import { judgeJSON } from "./judge.js";
import { completeJSON } from "./upstream.js";
import { MEDIA } from "./types.js";
import { flat, untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { kTriggers, PRIVATE_GUIDANCE } from "./config.js";
import { storeOf, record, newId, addFact, blockFor, ownFacts, passOn, noteSeen, overhear } from "./knowledge.js";
import type { KnowledgeConfig } from "./config.js";
import type { KBlock } from "./knowledge.js";
import type { Fact, FactAccess, GameState, Medium, Pending, RoomPlayer, Session } from "./types.js";

/** The judge calls of the knowledge feature, and the private-chat commands. The judge only classifies; code checks every answer. */

const READ_SYSTEM = `You turn one private message from a player of a shared game into a secret record, or say it is an ordinary note. Output ONLY JSON:
{"kind":"fact","text":"","about":"","known_by":[],"access":"never","watch":[],"discover":[]}
kind "fact": the player states something about their character, a person in the story or an event that only some people know (a goal, an agenda, a hidden trait, something only some of them saw). kind "note": anything else (a plan, an action, a question); then output only {"kind":"note"}.
text: the fact in one plain third-person sentence. about: the id of who it is about, from ACTORS. known_by: ids or names of everyone in the story who knows it ([] when nobody in the story knows it yet).
access: "never" when no character knows it yet (it stays hidden until found out), "roleplaying" when the characters in known_by know it and can act on it, "dm" when the player only wants it kept as their own note.
watch: up to 5 single words or short phrases that would give it away if a narration used them.
discover: how it could come out, [{"kind":"action","when":"what would be done or seen"},{"kind":"statement","by":"who would say it","when":"what they would say, in general words"}]; [] when the player gave no way.
${UNTRUSTED_NOTICE}`;

const TELL = `
kind "tell": the player says their character secretly passes something on to specific other characters (a whisper, a signal, a look, a note). Output {"kind":"tell","to":["id or name"],"medium":"whisper","fact":"","text":""}. to: only the characters named. medium: whisper, gesture, glance, sign, note or other. fact: the id of one of the sender's FACTS when that is what they pass on, else "". text: when fact is "", what they pass on, in one plain third-person sentence.`;

const COVERT_SYSTEM = `You list the secret dealings between characters in a shared game. You get the ACTORS (id, name, who controls them) and the latest NARRATION. Output ONLY JSON: {"covert":[{"from":"npc id","to":["npc id"],"medium":"glance","about":"actor id","content":"one plain sentence of what is passed on or planned"}]}
Only NPCs act in secret. List only what those characters would plausibly pass to each other without the others noticing (a look, a gesture, a sign, a whispered word), in line with the narration. Never repeat what the narration already states aloud. The content must be something concrete one character tells or asks another, who or what it is about ("Dex should keep the towel hidden from Bea"), never a description of the look, nod or gesture itself ("a nod of agreement"). [] when nothing.
${UNTRUSTED_NOTICE}`;

const TRIGGER_SYSTEM = `You watch a shared game for the moment a hidden thing is found out. You get TRIGGERS (fact.number, kind, condition), PENDING (triggers already seen, waiting for the person they concern to agree), the LINES the players wrote this round and the NARRATION. Output ONLY JSON:
{"fired":[{"fact":"f1","trigger":0,"evidence":"exact words copied from the lines or narration"}],"confirmed":[{"fact":"f1","trigger":0,"evidence":"exact words copied from that person's own lines"}]}
fired: only when the condition clearly happened in this round (a statement: said aloud by the person named). confirmed: only for PENDING items, when the person they concern clearly agrees or admits it in their own lines. Empty arrays when unsure. Never guess.
${UNTRUSTED_NOTICE}`;

const SPEAK_SYSTEM = `You read one round of a shared game. For each item (id and who knows it), say whether any of those people speaks, acts or is spoken to in the round. Output ONLY JSON: {"speaking":["f1"]}
${UNTRUSTED_NOTICE}`;

const strs = (v: unknown, max: number, len = 60): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, len)).slice(0, max) : []);
const id = (s: string): string => s.trim().replace(/^actors\./, "");

export interface ReadArgs { cfg: KnowledgeConfig; table: Session; me: RoomPlayer; text: string; state: GameState; turn: number }

/** The judge's reading of a private message: a fact or a transfer (checked by code), or null for an ordinary note. Throws when the answer cannot be used. */
export async function readFact(a: ReadArgs): Promise<Pending | null> {
  const k = storeOf(a.table, a.cfg);
  const tell = a.cfg.transfer !== "off";
  const actors = Object.entries(a.state.actors).map(([i, x]) => ({ id: i, name: x.name }));
  const mine = ownFacts(k, a.me.userId, a.me.actor).filter((f) => !f.revealed).map((f) => ({ id: f.id, text: f.text }));
  const j = await judgeJSON(READ_SYSTEM + (tell ? TELL : ""), `${PRIVATE_GUIDANCE ? `HOW THIS GAME USES THE PRIVATE CHANNEL: ${untrusted(PRIVATE_GUIDANCE)}\n` : ""}SENDER: ${untrusted(a.me.name)} (id ${a.me.actor})\nACTORS: ${untrusted(JSON.stringify(actors))}${tell ? `\nFACTS: ${untrusted(JSON.stringify(mine))}` : ""}\n<private_message>${untrusted(a.text)}</private_message>`, "knowledge_fact", 400);
  if (!j || typeof j !== "object" || !(j.kind === "fact" || j.kind === "note" || (tell && j.kind === "tell"))) throw new Error("the judge's answer was not usable");
  if (j.kind === "note") return null;
  const rest = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 400);
  if (j.kind === "tell") {
    const byName = (t: string): string | undefined => Object.entries(a.state.actors).find(([i, x]) => i === id(t) || (x.name && x.name.toLowerCase() === t.trim().toLowerCase()))?.[0];
    const to = [...new Set(strs(j.to, 5).map(byName).filter((x): x is string => !!x && x !== a.me.actor))];
    if (!to.length) throw new Error("no recipient the judge named is in the game");
    const medium: Medium = (MEDIA as readonly string[]).includes(j.medium) ? j.medium : "whisper";
    const held = typeof j.fact === "string" ? mine.find((f) => f.id === j.fact.trim()) : undefined;
    const real = held ? k.facts.find((f) => f.id === held.id) : undefined;
    if (real) {
      if (real.access === "dm") throw new Error("a note kept for yourself cannot be passed on");
      return { transfer: { fact: real.id, to, medium } };
    }
    const text = typeof j.text === "string" ? rest(j.text) : "";
    if (!text) throw new Error("nothing to pass on");
    return { fact: { id: newId(k), text, about: a.me.actor, knownBy: [a.me.actor, ...to], access: "roleplaying", watch: [], discover: [], createdBy: a.me.userId, createdTurn: a.turn } };
  }
  const text = typeof j.text === "string" ? rest(j.text) : "";
  if (!text) throw new Error("the judge's answer was not usable");
  const about = typeof j.about === "string" && j.about.trim() && (a.state.actors[id(j.about)] || id(j.about) === a.me.actor) ? id(j.about) : a.me.actor;
  let knownBy = strs(j.known_by, 10).map(id);
  if (about !== a.me.actor && !knownBy.includes(a.me.actor)) knownBy = [a.me.actor, ...knownBy]; // the sender may only record what they know or what is about them
  let access: FactAccess = ["never", "roleplaying", "dm"].includes(j.access) ? j.access : knownBy.length ? "roleplaying" : "never";
  if (access === "roleplaying" && !knownBy.length) access = "never";
  return { fact: { id: newId(k), text, about, knownBy, access, watch: strs(j.watch, 5, 40).map((w) => w.toLowerCase()), discover: kTriggers(j.discover), createdBy: a.me.userId, createdTurn: a.turn } };
}

const describe = (f: Fact): string => `${f.text} (about ${f.about}; ${f.access}${f.knownBy.length ? `, known to ${f.knownBy.join(", ")}` : ""}${f.discover.length ? `; comes out: ${f.discover.map((d) => d.when).join(" / ")}` : "; no way to find out set"})`;

const describeTransfer = (k: { facts: Fact[] }, t: { fact: string; to: string[]; medium: string }): string => `passing "${k.facts.find((f) => f.id === t.fact)?.text ?? t.fact}" on to ${t.to.join(", ")} by ${t.medium}`;

export interface PrivateK { cfg: KnowledgeConfig; table: Session; me: RoomPlayer; text: string; state: GameState }

/** A private message at a table with knowledge on. A reply text when it was a fact or a command; null when it is an ordinary note for the narrator. */
export async function privateKnowledge(a: PrivateK): Promise<string | null> {
  const { cfg, table, me } = a;
  const k = storeOf(table, cfg), turn = table.room!.rounds, t = a.text.trim();
  const pend = k.pending[me.userId];
  if (pend && cfg.confirm.test(t)) {
    delete k.pending[me.userId];
    if (pend.transfer) {
      const f = k.facts.find((x) => x.id === pend.transfer!.fact);
      if (!f) return "That fact is gone, so nothing was passed on.";
      const added = passOn(k, cfg, f, pend.transfer.to, pend.transfer.medium, turn);
      if (added.length) { noteSeen(table, cfg, me.name, added.map((i) => a.state.actors[i]?.name ?? i), pend.transfer.medium); await overhear(table, cfg, a.state, f, me.actor, pend.transfer.to, pend.transfer.medium, turn); }
      return added.length ? `Done: ${added.join(", ")} now know${added.length > 1 ? "" : "s"} it. Nobody else does.` : "They already knew it.";
    }
    const fact = pend.fact!;
    return addFact(k, cfg, fact, turn) ?? `Saved as ${fact.id}. Only you and the DM can see it; the narrator is not told until it matters.`;
  }
  if (pend && cfg.cancel.test(t)) { delete k.pending[me.userId]; return "Dropped. Nothing was saved."; }
  if (cfg.notesView && cfg.notes.test(t)) {
    const mine = ownFacts(k, me.userId, me.actor);
    record(k, cfg, turn, "viewed", me.userId);
    return mine.length ? mine.map((f) => `${f.id}${f.revealed ? " [revealed]" : ""}: ${describe(f)}`).join("\n") : "You have no facts recorded.";
  }
  const fm = cfg.notesView ? cfg.forget.exec(t) : null;
  if (fm) {
    const f = ownFacts(k, me.userId, me.actor).find((x) => x.id === fm[1] && x.createdBy === me.userId);
    if (!f) return `No fact ${fm[1]} of yours.`;
    k.facts.splice(k.facts.indexOf(f), 1);
    record(k, cfg, turn, "removed", f.id);
    return `Forgot ${f.id}.`;
  }
  if (!t) return null;
  let read: Pending | null;
  try { read = await readFact({ cfg, table, me, text: t, state: a.state, turn }); }
  catch (e) { console.warn("knowledge: could not read a private message:", (e as Error).message); return "I could not read that just now, so it was NOT passed on. Try again in a moment."; }
  if (!read) return null;
  if (cfg.confirmFacts === "off") {
    if (read.transfer) { const f = k.facts.find((x) => x.id === read!.transfer!.fact)!; const added = passOn(k, cfg, f, read.transfer.to, read.transfer.medium, turn); if (added.length) { noteSeen(a.table, a.cfg, a.me.name, added.map((i) => a.state.actors[i]?.name ?? i), read.transfer.medium); await overhear(a.table, a.cfg, a.state, f, a.me.actor, read.transfer.to, read.transfer.medium, turn); } return added.length ? `Done: ${added.join(", ")} now know${added.length > 1 ? "" : "s"} it.` : "They already knew it."; }
    return addFact(k, cfg, read.fact!, turn) ?? `Saved as ${read.fact!.id}.`;
  }
  k.pending[me.userId] = read;
  record(k, cfg, turn, "proposed", read.fact?.id ?? read.transfer!.fact, read.fact?.access ?? "transfer");
  return `I read this as ${read.transfer ? describeTransfer(k, read.transfer) : `a secret: ${describe(read.fact!)}`}. Reply yes to confirm, no to drop it. Nothing is passed on until you say yes.`;
}

/** The narrator's block for this round (match: judge asks the judge model which knowers are in the round; it never sees a fact's text). */
export async function knowledgeFor(session: Session, cfg: KnowledgeConfig, state: GameState, roundText: string): Promise<KBlock> {
  const k = storeOf(session, cfg);
  let speaking: Set<string> | undefined;
  const cand = k.facts.filter((f) => !f.revealed && f.access === "roleplaying" && f.knownBy.length);
  if (cfg.match === "judge" && cand.length) {
    try {
      const items = cand.map((f) => ({ id: f.id, knowers: f.knownBy.map((x) => state.actors[x]?.name || x) }));
      const j = await judgeJSON(SPEAK_SYSTEM, `ITEMS: ${untrusted(JSON.stringify(items))}\nROUND: ${untrusted(roundText.slice(0, 3000))}`, "knowledge_match", 200);
      if (j && Array.isArray(j.speaking)) speaking = new Set(strs(j.speaking, 50));
    } catch (e) { console.warn("knowledge: match judge failed, using names:", (e as Error).message); }
  }
  return blockFor(k, cfg, state, roundText, speaking);
}

export interface TriggerArgs { cfg: KnowledgeConfig; session: Session; state: GameState; lines: { actor: string; text: string }[]; narration: string; turn: number }

/** After a turn: expire old candidates, let the judge look for discoveries, and apply what code can verify (an exact quote; the person concerned wrote the confirmation). */
export async function checkTriggers(a: TriggerArgs): Promise<void> {
  const { cfg, session, state, lines, narration, turn } = a;
  const k = session.knowledge, room = session.room;
  if (!k || !room) return;
  for (const f of k.facts) if (f.candidate && f.candidate.expires < turn) { delete f.candidate; record(k, cfg, turn, "expired", f.id); }
  const live = k.facts.filter((f) => !f.revealed && f.discover.length);
  if (!live.length) return;
  const nameOf = (actor: string): string => state.actors[actor]?.name || actor;
  const trig = live.flatMap((f) => f.discover.map((d, i) => `${f.id}.${i} [${d.kind}${d.by ? ` by ${d.by}` : ""}] ${d.when}`));
  const pending = live.filter((f) => f.candidate).map((f) => `${f.id}.${f.candidate!.trigger} (waiting for ${nameOf(f.about)})`);
  const lineText = lines.map((l) => `[${nameOf(l.actor)} (actors.${l.actor})] ${l.text}`).join("\n");
  const j = await judgeJSON(TRIGGER_SYSTEM, `TRIGGERS:\n${untrusted(trig.join("\n"))}\nPENDING:\n${untrusted(pending.join("\n") || "(none)")}\nLINES:\n${untrusted(lineText)}\nNARRATION:\n${untrusted(narration.slice(-3000))}`, "knowledge_trigger", 300);
  if (!j || typeof j !== "object") return;
  const said = flat(lineText + " " + narration);
  const quoted = (ev: unknown, pool: string): boolean => typeof ev === "string" && flat(ev).length >= 3 && flat(pool).includes(flat(ev));
  const reveal = (f: Fact, i: number): void => { f.revealed = { turn, announced: false }; delete f.candidate; record(k, cfg, turn, "revealed", f.id, `trigger ${i} ${f.discover[i].kind}`); };
  const owner = (f: Fact): RoomPlayer | undefined => Object.values(room.players).find((p) => p.actor === f.about);
  for (const x of Array.isArray(j.fired) ? j.fired : []) {
    const f = live.find((y) => y.id === x?.fact), i = Number(x?.trigger);
    if (!f || f.revealed || !f.discover[i] || !quoted(x.evidence, said)) continue;
    const d = f.discover[i];
    const mode = d.confirm ?? (d.kind === "statement" ? cfg.statementConfirm : cfg.actionConfirm);
    if (mode === "owner" && owner(f)) { if (!f.candidate) { f.candidate = { trigger: i, turn, expires: turn + cfg.candidateTurns }; record(k, cfg, turn, "candidate", f.id, `trigger ${i}`); } }
    else reveal(f, i);
  }
  for (const x of Array.isArray(j.confirmed) ? j.confirmed : []) {
    const f = live.find((y) => y.id === x?.fact);
    if (!f || f.revealed || !f.candidate || f.candidate.trigger !== Number(x?.trigger)) continue;
    const mine = lines.filter((l) => l.actor === f.about).map((l) => l.text).join(" ");
    if (quoted(x.evidence, mine)) reveal(f, f.candidate.trigger); // the person concerned wrote it: code checks, not the judge
  }
}

export interface CovertArgs { cfg: KnowledgeConfig; session: Session; state: GameState; narration: string; turn: number }

/** After a round (transfer: covert): the model lists what NPCs secretly pass to each other; code keeps only what names real NPCs and fits the limits. Each becomes a fact known to those NPCs only. */
export async function covertActs(a: CovertArgs): Promise<number> {
  const { cfg, session, state, narration, turn } = a;
  const npcs = Object.entries(state.actors).filter(([, x]) => x.controlled_by === "npc");
  if (npcs.length < 2) return 0;
  const k = storeOf(session, cfg);
  const list = Object.entries(state.actors).map(([i, x]) => ({ id: i, name: x.name, controlled_by: x.controlled_by }));
  const body = `ACTORS: ${untrusted(JSON.stringify(list))}\nNARRATION:\n${untrusted(narration.slice(-2500))}`;
  const j = cfg.covertWith === "main" ? await completeJSON([{ role: "system", content: COVERT_SYSTEM }, { role: "user", content: body }], 400, "covert") : await judgeJSON(COVERT_SYSTEM, body, "covert", 400);
  let n = 0;
  const known = new Set(k.facts.map((f) => flat(f.text)));
  for (const x of Array.isArray(j?.covert) ? j.covert : []) {
    if (n >= cfg.covertMax) break;
    const from = typeof x?.from === "string" ? id(x.from) : "";
    const to = [...new Set(strs(x?.to, 4).map(id))].filter((t) => t !== from && state.actors[t]?.controlled_by === "npc");
    const text = typeof x?.content === "string" ? x.content.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (state.actors[from]?.controlled_by !== "npc" || !to.length || !text || known.has(flat(text))) continue;
    const about = typeof x.about === "string" && state.actors[id(x.about)] ? id(x.about) : from;
    const medium: Medium = (MEDIA as readonly string[]).includes(x.medium) ? x.medium : "gesture";
    const fact: Fact = { id: newId(k), text, about, knownBy: [from, ...to], access: "roleplaying", watch: [], discover: [], createdBy: "game", createdTurn: turn };
    if (addFact(k, cfg, fact, turn)) break;
    record(k, cfg, turn, "covert", fact.id, `from=${from} to=${to.join(",")} via=${medium}`);
    noteSeen(session, cfg, state.actors[from].name ?? from, to.map((t) => state.actors[t].name ?? t), medium);
    await overhear(session, cfg, state, fact, from, to, medium, turn);
    known.add(flat(text)); n++;
  }
  return n;
}
