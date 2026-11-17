import { SEATING, MULTIPLAYER, ACTOR_TEMPLATE, TERMS } from "./config.js";
import { announce } from "./announce.js";
import { logHand } from "./hand-log.js";
import { join as joinRoom, newRoom, adoptChat, syncPlayers } from "./multiplayer.js";
import { seat as rememberSeat } from "./seats.js";
import { checkSeatPhoto, photoRules } from "./seat-photo.js";
import { sendTerms } from "./terms.js";
import { saveImage, urlOf } from "./image-store.js";
import type { PlayerRef } from "./multiplayer.js";
import type { ChatMessage, SeatProfile, Session } from "./types.js";

/**
 * Gated seats (config.json `seating`). `/seat <age> <gender> [sexuality]` records a pending profile, `/seat yes` confirms it (the opt-in). Code checks the age (18 or more, `seating.min_age`, the table's
 * game.min_age) and the words; the profile is written to the actor by code, never by a model. A confirmed seat is taken at once between hands, else queued (and noted in hand_log) until the phase allows.
 */
const fill = (t: string, v: Record<string, unknown>): string => t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
/** The seated reply, with the terms notice when the game has terms. */
const seatedLine = (name: string): string => fill(SEATING!.texts.seated, { name }) + (TERMS ? ` ${TERMS.notice}` : "");
const phaseOk = (s: Session): boolean => SEATING!.phases.includes(String(s.snapshots.at(-1)?.game.phase ?? ""));
export const minAge = (s: Session): number => Math.max(SEATING!.minAge, Math.min(120, Math.floor(Number(s.snapshots.at(-1)?.game.min_age)) || 0));

function parse(arg: string, s: Session): SeatProfile | string {
  const T = SEATING!.texts, [ageTok, genderTok, ...rest] = arg.trim().split(/\s+/);
  const age = /^\d{1,3}$/.test(ageTok ?? "") ? Number(ageTok) : NaN;
  if (!Number.isFinite(age) || !genderTok) return T.usage;
  if (age < minAge(s)) return fill(T.age, { min: minAge(s) });
  const gender = genderTok.toLowerCase(), sexuality = rest.join(" ").toLowerCase() || SEATING!.defaultSexuality;
  const word = /^[\p{L} -]{1,30}$/u;
  if (!word.test(gender) || (SEATING!.genders.length && !SEATING!.genders.includes(gender))) return fill(T.gender, { list: SEATING!.genders.join(", ") || "a word" });
  if (sexuality && (!word.test(sexuality) || (SEATING!.sexualities.length && !SEATING!.sexualities.includes(sexuality)))) return fill(T.sexuality, { list: SEATING!.sexualities.join(", ") || "a word" });
  return { age, gender, sexuality };
}

/** Take the seat now: join the room, make the actor, write the profile. Null when the table is full. */
async function seatNow(s: Session, key: string, who: PlayerRef, profile: SeatProfile, now: number, prior?: ChatMessage[]): Promise<string | null> {
  const room = (s.room ??= newRoom()), st = s.snapshots.at(-1);
  if (!st || !MULTIPLAYER) return null;
  if (room.order.length === 0 && prior) adoptChat(room, prior); // the first seat turns the chat into a table
  const me = joinRoom(room, who, MULTIPLAYER, now);
  if (!me) return null;
  syncPlayers(st, room, ACTOR_TEMPLATE as Record<string, unknown>);
  if (profile.photo) me.photo = { name: profile.photo.name, kind: profile.photo.kind, at: profile.photo.at };
  const a = st.actors[me.actor] as Record<string, unknown>, f = SEATING!.fields;
  a[f.age] = profile.age; a[f.gender] = profile.gender; a[f.sexuality] = profile.sexuality;
  await rememberSeat(who.userId, key, now);
  await logHand(s, st, "seat", { userId: who.userId, actor: me.actor, seated: true });
  await sendTerms(s, who, now); // the game's terms, privately, once per person
  await maybeStart(s); // full seats start the show by themselves (seating.start.auto)
  return me.actor;
}

/** /seat: a profile, then yes. Returns the reply for that person. */
export async function sitCommand(s: Session, key: string, who: PlayerRef, arg: string, now: number, prior?: ChatMessage[]): Promise<string> {
  const T = SEATING!.texts, st = s.snapshots.at(-1);
  if (!st || s.mode !== "game") return T.game;
  const room = (s.room ??= newRoom());
  if (who.userId === "anonymous") return T.usage;
  const a = arg.trim();
  const owner = s.owner?.userId;
  const decide = /^(approve|deny)\s+(.+)$/i.exec(a);
  if (decide || /^list$/i.test(a)) { // the owner's side of an approval
    if (SEATING!.approval !== "owner") return T.usage;
    if (!owner || owner !== who.userId) return T.not_owner;
    const waiting = (room.seatQueue ?? []).filter((q) => !q.approved);
    if (!decide) return waiting.map((q) => fill(T.request, { name: q.name, ...q.profile, sexuality: q.profile.sexuality || "-" })).join("\n") || fill(T.no_request, { name: "" });
    const want = decide[2].trim().toLowerCase();
    const hit = waiting.find((q) => q.name.toLowerCase() === want) ?? (waiting.filter((q) => q.name.toLowerCase().startsWith(want)).length === 1 ? waiting.find((q) => q.name.toLowerCase().startsWith(want)) : undefined);
    if (!hit) return fill(T.no_request, { name: decide[2].trim() });
    if (decide[1].toLowerCase() === "deny") {
      room.seatQueue = room.seatQueue!.filter((q) => q !== hit);
      await logHand(s, st, "seat", { userId: hit.userId, denied: true });
      await announce(s, { kind: "seat", to: hit.userId, text: T.refused });
      return fill(T.denied, { name: hit.name });
    }
    hit.approved = true;
    await logHand(s, st, "seat", { userId: hit.userId, approved: true });
    const n = await seatQueued(s, key, now, prior);
    return fill(T.approved, { name: hit.name }) + (n ? ` ${seatedLine(hit.name)}` : ` ${T.queued}`);
  }
  if (room.players[who.userId]) return T.already;
  if (/^yes$/i.test(a)) {
    const profile = room.seatPending?.[who.userId];
    if (!profile) return T.none;
    if (SEATING!.photo?.required && !profile.photo) return photoRules(); // the seat waits for a checked picture (photoTurn finishes the confirmation)
    delete room.seatPending![who.userId];
    if (profile.age < minAge(s)) return fill(T.age, { min: minAge(s) });
    const approved = SEATING!.approval !== "owner" || owner === who.userId;
    if (!approved && !owner) return T.no_owner;
    if (approved && phaseOk(s)) return (await seatNow(s, key, who, profile, now, prior)) ? seatedLine(who.name) : T.full;
    room.seatQueue = [...(room.seatQueue ?? []).filter((q) => q.userId !== who.userId), { userId: who.userId, name: who.name, profile, at: now, approved }];
    await logHand(s, st, "seat", { userId: who.userId, queued: true, approved });
    if (!approved) {
      await announce(s, { kind: "seat", to: owner, text: fill(T.request, { name: who.name, ...profile, sexuality: profile.sexuality || "-" }) });
      return T.waiting;
    }
    return T.queued;
  }
  const profile = parse(a, s);
  if (typeof profile === "string") return profile;
  (room.seatPending ??= {})[who.userId] = profile;
  return fill(T.confirm, { ...profile, sexuality: profile.sexuality || "-", min: minAge(s) });
}

/** After a turn or command: seat the people queued during a hand once the phase allows. Returns how many sat down. */
export async function seatQueued(s: Session, key: string, now: number, prior?: ChatMessage[]): Promise<number> {
  const room = s.room, q = room?.seatQueue;
  if (!SEATING || !room || !q?.length || s.mode !== "game" || !phaseOk(s)) return 0;
  let n = 0;
  const rest: typeof q = [];
  for (const e of q) {
    if (room.players[e.userId]) continue;
    if (e.approved === false) { rest.push(e); continue; } // waits for the owner
    if (e.profile.age < minAge(s) || !(await seatNow(s, key, { userId: e.userId, name: e.name }, e.profile, now, prior))) { if (e.profile.age >= minAge(s)) rest.push(e); continue; }
    await announce(s, { kind: "seat", to: e.userId, text: SEATING.texts.welcome });
    n++;
  }
  room.seatQueue = rest;
  return n;
}

/** A person with a pending seat attached a picture: check it, and on a pass finish the confirmation. Null when this is not a seat picture (no pending seat, or no picture rule). */
export async function photoTurn(s: Session, key: string, who: PlayerRef, pictures: { mime: string; bytes: Buffer }[], now: number, prior?: ChatMessage[]): Promise<string | null> {
  const P = SEATING?.photo, profile = s.room?.seatPending?.[who.userId];
  if (!P || !profile || profile.photo || !pictures.length) return null;
  const v = await checkSeatPhoto(pictures[0].bytes);
  if (!v.ok) return P.texts[v.reason];
  let name: string;
  try { name = saveImage(pictures[0].bytes); } catch { return P.texts.format; }
  profile.photo = { name, kind: v.kind, at: now };
  return `${fill(P.texts.accepted, { kind: v.kind })} ${await sitCommand(s, key, who, "yes", now, prior)}`;
}

/** Seat photos older than `keep_hours` are removed from the players and the queue, and their files deleted. Call now and then (each turn is cheap). */
export function purgePhotos(s: Session, now: number, remove: (name: string) => void = () => {}): number {
  const P = SEATING?.photo, room = s.room;
  if (!P || !room) return 0;
  const old = (at: number): boolean => now - at > P.keepHours * 3_600_000;
  let n = 0;
  for (const p of Object.values(room.players)) if (p.photo && old(p.photo.at ?? 0)) { remove(p.photo.name); delete p.photo; n++; }
  for (const prof of [...Object.values(room.seatPending ?? {}), ...(room.seatQueue ?? []).map((q) => q.profile)]) if (prof.photo && old(prof.photo.at)) { remove(prof.photo.name); delete prof.photo; n++; }
  return n;
}

/** The photos of the people seated, as the table sees them at the start (markdown images). */
function photoBlock(s: Session): string {
  const P = SEATING?.photo;
  if (!P?.show || !s.room) return "";
  const lines = Object.values(s.room.players).filter((p) => p.photo).map((p) => `**${p.name}**\n![${p.name}](${urlOf(p.photo!.name)})`);
  return lines.length ? `${P.texts.shown}\n\n${lines.join("\n\n")}` : "";
}

async function begin(s: Session): Promise<void> {
  const st = s.snapshots.at(-1);
  if (!st || (st.game as Record<string, unknown>).started === true) return;
  (st.game as Record<string, unknown>).started = true;
  await announce(s, { kind: "start", text: [SEATING!.start!.texts.started, photoBlock(s)].filter(Boolean).join("\n\n") });
  await logHand(s, st, "seat", { started: true });
}

/** After a seat is taken: when every seat is filled (and checked, since a seat needs its picture) the show starts. */
export async function maybeStart(s: Session): Promise<void> {
  const S = SEATING?.start, room = s.room;
  if (!S?.auto || !room || !MULTIPLAYER || s.mode !== "game") return;
  if (Object.keys(room.players).length >= MULTIPLAYER.maxPlayers) await begin(s);
}

/** /start: the owner starts the show early, once at least `min_players` are seated. */
export async function startCommand(s: Session, who: PlayerRef): Promise<string> {
  const S = SEATING?.start, st = s.snapshots.at(-1);
  if (!S || !st || !MULTIPLAYER) return SEATING?.texts.game ?? "";
  if (!s.owner || s.owner.userId !== who.userId) return S.texts.not_owner;
  if ((st.game as Record<string, unknown>).started === true) return S.texts.already;
  const have = Object.keys(s.room?.players ?? {}).length;
  if (!S.early || have < MULTIPLAYER.minPlayers) return fill(S.texts.few, { have, need: MULTIPLAYER.minPlayers });
  await begin(s);
  return S.texts.started;
}
