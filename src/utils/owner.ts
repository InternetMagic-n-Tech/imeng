import crypto from "node:crypto";
import { dbg } from "./debug.js";
import { MLFLOW_ON, TELEMETRY_ENABLED, MODEL_ID, SESSION_TTL_DAYS } from "./config.js";
import { stateDb } from "./db-state.js";
import { OWNER, TELEMETRY_NOTICE, ownerText, telemetryText } from "./owner-config.js";
import { eligible } from "./tone.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Ownership, Session } from "./types.js";

/**
 * Who owns a chat, and what players are told about telemetry.
 * The owner is a real person (never an NPC, frozen or not): whoever speaks first, or whoever starts the chat. Ownership moves only through
 * /claim after the owner has been away for owner.vanish_after, and the move is told to the table. Open WebUI's own chat transfer does nothing here.
 * Telemetry: with MLflow on, the first reply says so; /telemetry off (owner only) stops it for this chat, and every change is told.
 */

export type OwnerCommand = "owner" | "successor" | "claim" | "keep" | "handover" | "telemetry";
export const OWNER_COMMANDS: OwnerCommand[] = ["owner", "successor", "claim", "keep", "handover", "telemetry"];

const norm = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");
const keep = (a: string): string => (OWNER?.answers === "plain" ? norm(a) : crypto.createHash("sha256").update(norm(a)).digest("hex"));
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const real = (who: PlayerRef): boolean => who.userId !== "anonymous";

export function ensureOwnership(session: Session, who: PlayerRef, now: number, touch = true): Ownership {
  const own = (session.own ??= { created: now, successors: [], people: {}, telemetry: "on", challenge: [], claims: {}, notices: [] });
  if (real(who) && touch) { const p = own.people[who.userId]; own.people[who.userId] = { ...p, name: who.name, seen: now, msgs: (p?.msgs ?? 0) + 1 }; } // a command is not presence: only a spoken turn counts
  if (!session.owner && real(who) && (OWNER || session.mode === "game")) session.owner = { userId: who.userId, name: who.name };
  if (OWNER && session.owner && !own.challenge.length) own.challenge = OWNER.challenge.map((id) => ({ id, a: keep(id === "created" ? day(own.created) : session.owner!.name) }));
  if (OWNER && session.owner) {
    if (session.owner.userId === who.userId && touch) {
      own.closed = false; own.claims = {};
      if (!own.askedAt) own.askedAt = now; // the week starts the first time the owner speaks
      else if (now - own.askedAt >= OWNER.askMs && !own.asking) { // asked once per period, until they answer
        own.asking = true; own.askedAt = now;
        own.notices.push(ownerText("ask", { owner: session.owner.name, list: suggest(session, now).map((c) => c.name).join(", ") || ownerText("none") }));
      }
    }
    else if (!heir(session, now) && OWNER.fallback === "close" && away(session, now)) own.closed = true;
  }
  return own;
}

const away = (s: Session, now: number): boolean => !!OWNER && !!s.owner && now - (s.own?.people[s.owner.userId]?.seen ?? now) >= OWNER.vanishMs;
const gone = (s: Session, id: string, now: number): boolean => !!OWNER && now - (s.own?.people[id]?.seen ?? 0) >= OWNER.vanishMs;

/** The change is also kept as a typed event (the line is already in the notices, so it is marked delivered and a hook may re-deliver it, e.g. as a DM). */
function recordOwnerChange(s: Session, from: string, to: string, at: number): void {
  (s.announcements ??= []).push({ id: `owner-${s.announcements.length + 1}`, kind: "owner", from, to, text: s.own!.notices.at(-1) ?? "", at, delivered: true });
}

/** How suitable a person is as the next owner: steady, recent activity, and (when the tone judge has scored them) good behaviour. Code only; the numbers are cheap to tune. */
export function score(p: { seen: number; msgs?: number; tone?: number }, now: number): number {
  const active = Math.min(1, Math.log1p(p.msgs ?? 0) / Math.log1p(100)); // 100 turns is as active as it matters
  const recent = Math.max(0, 1 - (now - p.seen) / (14 * 86_400_000)); // gone for two weeks: nothing
  return +(0.4 * active + 0.3 * recent + 0.3 * (p.tone ?? 0.5)).toFixed(3);
}
/** The best candidates other than the owner, best first. Ones already named successors come first. */
export function suggest(s: Session, now: number, n = 3): { userId: string; name: string; score: number }[] {
  const own = s.own;
  if (!own || !s.owner) return [];
  return Object.entries(own.people).filter(([id, p]) => id !== s.owner!.userId && eligible(p)).map(([userId, p]) => ({ userId, name: p.name, score: score(p, now) + (own.successors.some((x) => x.userId === userId) ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, n);
}

/** The first successor who has not vanished too; null when there is none. */
function heir(s: Session, now: number): { userId: string; name: string } | null {
  return s.own?.successors.find((p) => !gone(s, p.userId, now)) ?? null;
}

/** What to say instead of playing, when the chat is closed. */
export function closedReply(s: Session): string | null { return s.own?.closed ? ownerText("closed") : null; }

export const telemetryOn = (s: Session): boolean => MLFLOW_ON && s.own?.telemetry !== "off";

/** The telemetry line (and any table notices) for this reply. Call `commit` once the reply is going out. */
export function ownerNotice(s: Session): { text: string; commit: () => void } {
  const own = s.own;
  if (!own) return { text: "", commit: () => {} };
  const lines: string[] = [];
  const state = telemetryOn(s) ? "on" : "off";
  const reason = ownerText(own.telemetry === "off" ? "reason_owner" : "reason_server");
  let tell = false;
  if (TELEMETRY_NOTICE === "always" && own.disclosed !== state && (own.disclosed !== undefined || state === "on")) {
    tell = true;
    lines.push(state === "on" ? telemetryText(own.disclosed === "off" ? "on_again" : "on", { reason: own.reason || ownerText("reason_owner") }) : telemetryText("off", { reason }));
  }
  const notices = own.notices.splice(0);
  lines.push(...notices);
  const text = lines.join("\n\n");
  return { text, commit: () => { if (tell || own.disclosed === undefined) own.disclosed = state; } };
}

export function ownerCommand(name: OwnerCommand, arg: string, c: { session: Session; who: PlayerRef; now: number }): string {
  const s = c.session;
  const own = ensureOwnership(s, c.who, c.now, false);
  const owner = s.owner;
  dbg("owner")("/%s by %s", name, c.who.userId);
  if (!owner) return ownerText("no_owner");
  const isOwner = owner.userId === c.who.userId;
  const notOwner = ownerText("not_owner", { name: owner.name });
  const list = (): string => own.successors.map((p) => p.name).join(", ") || ownerText("none");
  if (name === "owner") return ownerText("owner", { name: owner.name, successors: list(), telemetry: telemetryOn(s) ? "on" : "off" });
  if (name === "successor") {
    const [verb, ...rest] = arg.trim().split(/\s+/);
    const who = rest.join(" ").trim();
    if (!verb) return ownerText("successors", { list: list() });
    if ((verb === "accept" || verb === "decline") && OWNER?.tone) { // a person answers for themselves
      if (isOwner) return ownerText("owner_cannot");
      const me = own.people[c.who.userId];
      if (!me) return ownerText("unknown_who", { who: c.who.name });
      me.consent = verb === "accept" ? "yes" : "no";
      if (verb === "decline") { me.recent = []; delete me.tone; own.successors = own.successors.filter((p) => p.userId !== c.who.userId); }
      return ownerText(verb === "accept" ? "accepted" : "declined");
    }
    if (!isOwner) return notOwner;
    if (verb !== "add" && verb !== "remove") return ownerText("successor_usage");
    const hit = Object.entries(own.people).find(([id, p]) => id !== owner.userId && norm(p.name) === norm(who));
    if (verb === "add") {
      if (!hit) return ownerText("unknown_who", { who });
      if (!eligible(hit[1])) return ownerText(hit[1].consent === "yes" ? "tone_low" : "not_consented", { who: hit[1].name });
      if (!own.successors.some((p) => p.userId === hit[0])) own.successors.push({ userId: hit[0], name: hit[1].name });
      return ownerText("successor_added", { who: hit[1].name, n: String(own.successors.findIndex((p) => p.userId === hit[0]) + 1) });
    }
    const at = own.successors.findIndex((p) => norm(p.name) === norm(who));
    if (at < 0) return ownerText("unknown_who", { who });
    const [gonePerson] = own.successors.splice(at, 1);
    return ownerText("successor_removed", { who: gonePerson.name });
  }
  if (name === "keep") {
    if (!isOwner) return notOwner;
    if (!own.asking) return ownerText("not_asked");
    own.asking = false;
    return ownerText("kept", { name: owner.name });
  }
  if (name === "handover") {
    if (!isOwner) return notOwner;
    const want = arg.trim();
    if (!want) return ownerText("handover_usage");
    const hit = Object.entries(own.people).find(([id, p]) => id !== owner.userId && norm(p.name) === norm(want));
    if (!hit) return ownerText("unknown_who", { who: want });
    const old = owner.name;
    s.owner = { userId: hit[0], name: hit[1].name };
    own.successors = own.successors.filter((p) => p.userId !== hit[0]);
    own.asking = false; own.askedAt = c.now; own.claims = {};
    own.challenge = []; // the new owner's questions are made from their own name on their next turn
    const line = ownerText("handed", { name: hit[1].name, old });
    own.notices.push(line);
    recordOwnerChange(s, old, hit[0], c.now);
    return line;
  }
  if (name === "telemetry") {
    const want = norm(arg);
    if (!want || want === "status") return ownerText("telemetry_status", { state: telemetryOn(s) ? "on" : "off" });
    if (want !== "on" && want !== "off") return ownerText("telemetry_status", { state: telemetryOn(s) ? "on" : "off" });
    if (!isOwner) return notOwner;
    if (want === "on" && !MLFLOW_ON) return TELEMETRY_ENABLED ? ownerText("telemetry_unavailable") : ownerText("telemetry_server_off");
    const was = telemetryOn(s);
    own.telemetry = want;
    own.reason = ownerText("reason_owner");
    if (MLFLOW_ON && was !== (want === "on")) { own.disclosed = want; return telemetryText(want === "on" ? "on_again" : "off", { reason: own.reason }); }
    return ownerText("telemetry_status", { state: telemetryOn(s) ? "on" : "off" });
  }
  // claim
  if (isOwner) return ownerText("not_away");
  if (!away(s, c.now)) return ownerText("not_away");
  const next = heir(s, c.now);
  if (next && next.userId !== c.who.userId) return ownerText("not_heir", { name: next.name });
  if (!next && OWNER!.fallback !== "open") { own.closed = true; return ownerText("closed"); }
  if (!next && !own.people[c.who.userId]) return ownerText("not_heir", { name: owner.name });
  const prog = (own.claims[c.who.userId] ??= { step: 0, fails: 0 });
  if (prog.fails >= OWNER!.maxFails) return ownerText("locked");
  const q = own.challenge[prog.step];
  if (!q) return ownerText("usage_claim");
  if (!arg.trim()) return ownerText(`question_${q.id}`);
  if (keep(arg) !== q.a) {
    prog.fails++;
    return prog.fails >= OWNER!.maxFails ? ownerText("locked") : ownerText("wrong", { left: String(OWNER!.maxFails - prog.fails) });
  }
  prog.step++;
  const nextQ = own.challenge[prog.step];
  if (nextQ) return ownerText(`question_${nextQ.id}`);
  const old = owner.name;
  s.owner = { userId: c.who.userId, name: c.who.name };
  own.successors = own.successors.filter((p) => p.userId !== c.who.userId);
  own.claims = {};
  own.closed = false;
  const line = ownerText("claimed", { name: c.who.name, old });
  own.notices.push(line);
  recordOwnerChange(s, old, c.who.userId, c.now);
  return line;
}

/** Keep the long-term list of possible next owners (table `candidates`) current for this chat. Best effort: a database that is down never stops a game. */
export async function syncCandidates(session: Session, thread: string, game: string, now = Date.now()): Promise<void> {
  const db = stateDb();
  if (!db || !session.own || !session.owner) return;
  const expires = now + SESSION_TTL_DAYS * 86_400_000;
  try {
    for (const c of suggest(session, now, 10)) {
      const p = session.own.people[c.userId]!;
      const row = { name: p.name, score: c.score, msgs: p.msgs ?? 0, last_seen: p.seen, expires_at: expires };
      const upd = await db.updateTable("candidates").set(row).where("thread", "=", thread).where("user_id", "=", c.userId).executeTakeFirst();
      if (!Number(upd.numUpdatedRows ?? 0)) await db.insertInto("candidates").values({ thread, user_id: c.userId, game, ...row }).execute();
    }
  } catch (e) { console.warn(`candidates: could not save: ${(e as Error).message}`); }
}
