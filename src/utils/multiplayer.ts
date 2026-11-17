import { gameDefaults } from "./state.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MULTIPLAYER_DEBUG, SAVE_DIR, USER_ID, MODEL_ID } from "./config.js";
import { slug, validId } from "./domains.js";
import { humanDuration } from "./durations.js";
import { contentText } from "./text.js";
import type { MultiplayerConfig } from "./config.js";
import type { ChatMessage, GameState, Room, RoomPlayer, Standing, TalkLine } from "./types.js";

/**
 * Several real people, one game (config.json: multiplayer). The table is a chat shared with Open WebUI's "Allow replies" (or a channel): one chat
 * id, so one session, and each request carries the sender's own user id. The room is the shared side: who sits at the table, what has been said
 * since the last round, who has confirmed, who stepped away, what each player asked to happen if the game waits on them too long, and the private
 * notes players passed from their own chats. Pure functions over a Room, so they are testable; app.ts does the wiring and the judge model
 * (utils/room-judge.ts) supplies the `verdict` of a message.
 */

const MENTION = /^(\s*@\S+)+\s*/; // "@game ready": the mention is not part of what was said
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OWN_MENTION = new RegExp(`^\\s*@${escapeRe(MODEL_ID)}(?![\\w-])\\s*`, "i"); // the game's own name, even with spaces in it

export const newRoom = (): Room => ({ players: {}, order: [], talk: [], confirmed: [], notes: [], history: [], rounds: 0 });

export interface PlayerRef { userId: string; name: string }

const decoded = (v: string): string => { try { return decodeURIComponent(v); } catch { return v; } };

/** Who is asking: the headers Open WebUI adds when ENABLE_FORWARD_USER_INFO_HEADERS is on (it URL-encodes the name). */
export function playerOf(get: (h: string) => string | undefined): PlayerRef {
  const userId = (get("x-openwebui-user-id") || "").trim() || "anonymous";
  const name = decoded((get("x-openwebui-user-name") || "").trim()) || (userId === "anonymous" ? "Player" : userId.slice(0, 8));
  return { userId, name: name.slice(0, 40) };
}

// ---------- the room ----------

/** The chat becomes a table: the story so far is the room's transcript and its round count. Whoever first puts people in the room (a message or /seat) does this, once. */
export function adoptChat(room: Room, prior: ChatMessage[]): void {
  room.history = prior.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: contentText(m.content) }));
  room.rounds = room.history.filter((m) => m.role === "user").length;
}

/** Add the person if new (and give them an actor id), or note that they are here now. Returns null when the room is full. */
export function join(room: Room, p: PlayerRef, cfg: MultiplayerConfig, now: number): RoomPlayer | null {
  const known = room.players[p.userId];
  if (known) { known.lastSeen = now; if (p.name && p.name !== "Player") known.name = p.name; return known; }
  if (room.order.length >= cfg.maxPlayers) return null;
  const taken = new Set(Object.values(room.players).map((x) => x.actor));
  let actor = room.order.length === 0 ? USER_ID : `p_${slug(p.name) || "player"}`;
  for (let n = 2; taken.has(actor) || !validId(actor); n++) actor = `p_${slug(p.name) || "player"}_${n}`;
  const player: RoomPlayer = { userId: p.userId, name: p.name, actor, lastSeen: now };
  room.players[p.userId] = player;
  room.order.push(p.userId);
  return player;
}

/** Make sure every player has an actor in the state (the first plays actors.user); real people are never NPCs. */
export function syncPlayers(state: GameState, room: Room, template: Record<string, unknown>): void {
  for (const userId of room.order) {
    const p = room.players[userId];
    const a = state.actors[p.actor];
    if (a) {
      a.controlled_by = p.actor === USER_ID ? "user" : "other_player";
      if (!a.name || a.name === "you") a.name = p.name;
    } else {
      state.actors[p.actor] = { ...structuredClone(template), ...gameDefaults(state), name: p.name, controlled_by: "other_player" } as GameState["actors"][string];
    }
  }
}

export const activePlayers = (room: Room, cfg: MultiplayerConfig, now: number): RoomPlayer[] =>
  room.order.map((id) => room.players[id]).filter((p) => !cfg.idleMs || now - p.lastSeen <= cfg.idleMs);

/** The last thing the narrator said, shortened: the scene the table is in. */
export const lastScene = (room: Room, max = 400): string => {
  const t = String(room.history.filter((m) => m.role === "assistant").at(-1)?.content ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
};

// ---------- what a judge (or code) says about a message ----------

export interface Verdict {
  /** act: it is their move (starts a round). hold: not their moment yet. chat: table talk. pause: stepping away. return: back. */
  kind: "act" | "hold" | "chat" | "pause" | "return";
  /** Names of the players the story is now waiting on (policy judged). */
  awaiting?: string[];
  standing?: { afterRealMs?: number; afterGame?: number; action: string } | null;
  cancelStanding?: boolean;
}

export interface StepCtx {
  now: number;
  /** The in-game clock now (config.json: multiplayer.clock), when there is one. */
  game?: number;
  /** The actor whose turn it is (policy token). */
  token?: string | null;
  /** The real-time limit the table agreed (default_after.real_from), when the game keeps one: replaces default_after.real. */
  defaultRealMs?: number;
  verdict?: Verdict | null;
  /** A field of an actor in the state, for ordering by a field. */
  field?: (actor: string, field: string) => unknown;
  /** True for an actor the game ignores (multiplayer.silenced_when, the dead): the round does not wait for their player. */
  silenced?: (actor: string) => boolean;
}

/** What the table is holding its breath on: for a tension beat (the narrator's one short line while the game waits). */
export interface Hold {
  /** Who the game waits for. */
  waiting: string[];
  /** What players have declared so far this round, one entry per line. */
  declared: { who: string; text: string }[];
  /** The message that just came in (not the waiting player's own), if it said something. */
  spoke?: { who: string; text: string };
  /** The last narration. */
  scene: string;
}

export type Step =
  /** Answer in code (the terse status), or let the narrator write a tension beat from `hold`. No round yet. */
  | { kind: "reply"; text: string; hold?: Hold }
  /** Narrate a round: `text` is what the players said (with their actors, for the recorder), `messages` the room's transcript with it added. */
  | { kind: "round"; text: string; messages: ChatMessage[]; players: RoomPlayer[] };

// ---------- ordering and the text of a round ----------

function sequence(room: Room, cfg: MultiplayerConfig, ctx: StepCtx, lines: TalkLine[]): TalkLine[] {
  const o = cfg.order;
  if (o === "filo") return [...lines].reverse();
  const byJoin = (a: TalkLine, b: TalkLine): number => room.order.indexOf(a.userId) - room.order.indexOf(b.userId);
  if (o === "join") return [...lines].sort(byJoin); // stable: a player's own lines keep their order
  if (o === "random") { const a = [...lines]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  if (typeof o === "object" && ctx.field) {
    const val = (t: TalkLine): number => { const v = Number(ctx.field!(room.players[t.userId].actor, o.by)); return Number.isFinite(v) ? v : o.desc ? -Infinity : Infinity; };
    return [...lines].sort((a, b) => (o.desc ? val(b) - val(a) : val(a) - val(b)) || byJoin(a, b));
  }
  return lines; // fifo
}

function lineText(room: Room, t: TalkLine, ctx: StepCtx): string {
  const p = room.players[t.userId];
  const head = `[${p.name} (actors.${p.actor})]`;
  return t.auto ? `${head} (not heard from in ${humanDuration(ctx.now - (room.openedAt ?? ctx.now))}; ${t.text})` : `${head} ${t.text}`;
}

/** The round the players' lines make (and the private notes passed meanwhile), then the table is clear for the next one. */
function compose(room: Room, cfg: MultiplayerConfig, ctx: StepCtx, notes: string[], players: RoomPlayer[], lines?: TalkLine[]): Step {
  const talk = lines ?? room.talk;
  const body = talk.length
    ? sequence(room, cfg, ctx, talk).map((t) => lineText(room, t, ctx))
    : players.map((x) => `[${x.name} (actors.${x.actor})] (ready; says nothing)`);
  const secrets = cfg.priv?.narratorSees ? room.notes.filter((n) => room.players[n.userId]).map((n) => { const p = room.players[n.userId]; return `[${p.name} (actors.${p.actor})] PRIVATE, never reveal to the other players: ${n.text}`; }) : [];
  const away = room.order.map((id) => room.players[id]).filter((x) => x.away).map((x) => x.name);
  const seen = (room.whispers ?? []).map((w) => `NOTE: Everyone at the table saw this happen (not what it was): ${w}.`);
  const heard = (room.overheard ?? []).map((w) => `NOTE: Only the narrator knows this; the table does not (play it in character, never announce it): ${w}.`);
  const text = [...seen, ...heard, ...(away.length ? [`NOTE: Away right now (their characters sit out): ${away.join(", ")}.`] : []), ...notes, ...body, ...secrets].join("\n");
  room.whispers = []; room.overheard = []; room.talk = []; room.confirmed = []; room.awaiting = undefined; room.notes = []; room.beat = undefined;
  room.openedAt = ctx.now; room.openedGame = ctx.game;
  return { kind: "round", text, messages: [...room.history, { role: "user", content: text }], players };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
function backNote(me: RoomPlayer, cfg: MultiplayerConfig, ctx: StepCtx): string {
  const away = me.away!;
  let note = `NOTE: ${me.name} is back after ${humanDuration(ctx.now - away.realAt)} away`;
  if (cfg.clock && ctx.game !== undefined && away.gameAt !== undefined) {
    const d = Math.round((ctx.game - away.gameAt) * 100) / 100;
    note += `; in the story ${cfg.clock.unit === "count" ? plural(d, "step") : plural(d, cfg.clock.unit)} passed meanwhile`;
  }
  return note + ".";
}

// ---------- waiting on someone, and giving up ----------

const holderOf = (room: Room, ctx: StepCtx): RoomPlayer | undefined => (ctx.token ? Object.values(room.players).find((x) => x.actor === ctx.token) : undefined);

/** Who the round is waiting on right now. */
export function blocking(room: Room, cfg: MultiplayerConfig, ctx: StepCtx, active: RoomPlayer[]): RoomPlayer[] {
  if (cfg.turns === "ready") return active.filter((x) => !x.away && !x.frozen && !ctx.silenced?.(x.actor) && !room.confirmed.includes(x.userId));
  if (cfg.turns === "token") { const h = holderOf(room, ctx); return h && !h.frozen ? [h] : []; }
  if (cfg.turns === "judged") return (room.awaiting ?? []).map((id) => room.players[id]).filter((x): x is RoomPlayer => !!x && !x.frozen);
  return [];
}

/** The standing instruction (or the game's default) that applies to this player now, if its time has come. */
function dueFor(room: Room, p: RoomPlayer, cfg: MultiplayerConfig, ctx: StepCtx): Standing | null {
  const eff: Standing | null = p.standing ?? (cfg.defaultAfter ? { afterRealMs: ctx.defaultRealMs ?? cfg.defaultAfter.realMs, afterGame: cfg.defaultAfter.game, action: cfg.defaultAction, setAt: 0 } : null);
  if (!eff) return null;
  const real = eff.afterRealMs !== undefined && ctx.now - (room.openedAt ?? ctx.now) >= eff.afterRealMs;
  const game = eff.afterGame !== undefined && ctx.game !== undefined && room.openedGame !== undefined && ctx.game - room.openedGame >= eff.afterGame;
  return real || game ? eff : null;
}

/** Players the game has waited on too long act on their own (what they left, or the game's default). Returns how many. */
function sweep(room: Room, cfg: MultiplayerConfig, ctx: StepCtx, active: RoomPlayer[]): number {
  let n = 0;
  for (const p of blocking(room, cfg, ctx, active)) {
    const eff = dueFor(room, p, cfg, ctx);
    if (!eff) continue;
    if (!room.talk.some((t) => t.userId === p.userId)) room.talk.push({ userId: p.userId, text: eff.action, auto: true });
    if (!room.confirmed.includes(p.userId)) room.confirmed.push(p.userId);
    if (cfg.turns === "judged" && room.awaiting) room.awaiting = room.awaiting.filter((id) => id !== p.userId);
    n++;
  }
  return n;
}

// ---------- stepping away, standing instructions, private notes ----------

export interface Applied { paused: boolean; standingSet: boolean; standingCleared: boolean; back?: string }

/**
 * What a reading of a message does to the sender: back from being away (anything but a pause: speaking again is the opt-in), a pause (no reason is
 * kept), a standing instruction (only from a private chat unless the game says `standing: "any"`), or withdrawing one.
 */
export function applyVerdict(room: Room, me: RoomPlayer, v: Verdict | null, cfg: MultiplayerConfig, ctx: StepCtx, isPrivate: boolean): Applied {
  const out: Applied = { paused: false, standingSet: false, standingCleared: false };
  if (me.away && v?.kind !== "pause") { out.back = backNote(me, cfg, ctx); delete me.away; }
  if (v?.cancelStanding && me.standing) { delete me.standing; out.standingCleared = true; }
  if (v?.standing && v.standing.action && (isPrivate || cfg.standing === "any") && (v.standing.afterRealMs !== undefined || v.standing.afterGame !== undefined)) {
    me.standing = { ...v.standing, setAt: ctx.now };
    out.standingSet = true;
  }
  if (v?.kind === "pause") { if (!me.away) me.away = { realAt: ctx.now, gameAt: ctx.game }; out.paused = true; }
  return out;
}

/** A private note for the narrator (from the player's own chat); it goes in with the next round. */
export function addNote(room: Room, userId: string, text: string): void {
  room.notes.push({ userId, text: text.slice(0, 1000) });
  if (room.notes.length > 40) room.notes.splice(0, room.notes.length - 40);
}

/** The person leaves the table: they are away until they speak at it again. */
export function leaveTable(room: Room, userId: string, ctx: StepCtx): void {
  const me = room.players[userId];
  if (me && !me.away) me.away = { realAt: ctx.now, gameAt: ctx.game };
}

const reply = (text: string, hold?: Hold): Step => ({ kind: "reply", text, hold });

/** What the table is waiting on, for the status line or a tension beat. */
function holdOf(room: Room, cfg: MultiplayerConfig, ctx: StepCtx, active: RoomPlayer[], who: RoomPlayer, said: string): Hold {
  const last = new Map<string, string>();
  for (const t of room.talk) if (!t.auto) last.set(t.userId, t.text);
  return {
    waiting: blocking(room, cfg, ctx, active).map((x) => x.name),
    declared: [...last].map(([id, text]) => ({ who: room.players[id].name, text })),
    spoke: said ? { who: who.name, text: said } : undefined,
    scene: lastScene(room),
  };
}

/**
 * One message from one player at the table. Returns null when the room is full.
 * - policy ready: free talk is collected; when every player we wait for has confirmed, one round is narrated for all of them.
 * - policy free: every message is a round. token: the holder acts, the others are noted or queued. judged: the verdict decides.
 * - Whatever the policy, with fewer than min_players in the room every message is a round.
 * - A verdict pause/return, a standing instruction (only with `standing: "any"` here) and a timeout apply in every policy (see docs/MULTIPLAYER.md).
 */
export function step(room: Room, p: PlayerRef, rawText: string, cfg: MultiplayerConfig, ctx0: number | StepCtx): Step | null {
  const ctx: StepCtx = typeof ctx0 === "number" ? { now: ctx0 } : ctx0;
  const me = join(room, p, cfg, ctx.now);
  if (!me) return null;
  if (room.openedAt === undefined) { room.openedAt = ctx.now; room.openedGame = ctx.game; }
  const text = rawText.replace(OWN_MENTION, "").replace(MENTION, "").trim();
  const v = ctx.verdict ?? null;
  const notes: string[] = [];
  const players = (): RoomPlayer[] => activePlayers(room, cfg, ctx.now);

  const ap = applyVerdict(room, me, v, cfg, ctx, false);
  if (ap.back) notes.push(ap.back);

  if (ap.paused) {
    const active = players();
    // the others may have been waiting only for this player
    if (cfg.turns === "ready" && room.talk.length + room.confirmed.length > 0 && blocking(room, cfg, ctx, active).length === 0 && active.some((x) => !x.away)) return compose(room, cfg, ctx, notes, active.filter((x) => !x.away));
    return reply(`${me.name} has stepped away; the game won't wait for them.`);
  }

  const line: TalkLine | null = text ? { userId: p.userId, text } : null;
  const active = players();
  const solo = active.length < cfg.minPlayers;

  if (cfg.turns === "free" || solo) {
    if (v?.kind === "chat" && !solo) return reply("Noted.");
    if (line) room.talk.push(line);
    return compose(room, cfg, ctx, notes, active);
  }

  if (cfg.turns === "ready") {
    if (cfg.confirm.test(text)) {
      if (!room.confirmed.includes(p.userId)) room.confirmed.push(p.userId);
    } else if (line) {
      room.talk.push(line);
      if (cfg.resetOnTalk) room.confirmed = room.confirmed.filter((id) => id !== p.userId);
    }
    const waiting = blocking(room, cfg, ctx, active);
    if (waiting.length === 0 && active.some((x) => !x.away)) return compose(room, cfg, ctx, notes, active.filter((x) => !x.away));
    if (sweep(room, cfg, ctx, active) > 0 && blocking(room, cfg, ctx, active).length === 0) return compose(room, cfg, ctx, notes, active.filter((x) => !x.away));
    return reply(statusText(room, cfg, ctx, active, ""), holdOf(room, cfg, ctx, active, me, cfg.confirm.test(text) ? "" : text));
  }

  if (cfg.turns === "token") {
    const holder = holderOf(room, ctx);
    if (!holder || holder.userId === p.userId) { // the holder acts (or nobody holds the token: anyone may)
      if (line) room.talk.push(line);
      return compose(room, cfg, ctx, notes, active);
    }
    if (line && cfg.offTurn === "queue") room.talk.push(line);
    if (sweep(room, cfg, ctx, active) > 0) return compose(room, cfg, ctx, notes, active);
    return reply(cfg.offTurn === "queue" ? `Queued for ${holder.name}'s turn.` : `It's ${holder.name}'s turn.`, holdOf(room, cfg, ctx, active, me, text));
  }

  // judged
  if (v?.awaiting) room.awaiting = v.awaiting.map((n) => Object.values(room.players).find((x) => x.name.toLowerCase() === n.toLowerCase())?.userId).filter((id): id is string => !!id);
  if (!v || v.kind === "act" || v.kind === "return") {
    if (line) room.talk.push(line);
    return compose(room, cfg, ctx, notes, active);
  }
  if (line && v.kind === "hold" && cfg.offTurn === "queue") room.talk.push(line);
  if (sweep(room, cfg, ctx, active) > 0) return compose(room, cfg, ctx, notes, active);
  return reply(v.kind === "hold" ? (cfg.offTurn === "queue" ? "Noted; it goes in when your moment comes." : "Noted. The story isn't waiting on you yet.") : "Noted.", holdOf(room, cfg, ctx, active, me, text));
}

function statusText(room: Room, cfg: MultiplayerConfig, ctx: StepCtx, active: RoomPlayer[], lead: string): string {
  const ready = active.filter((x) => room.confirmed.includes(x.userId)).map((x) => x.name);
  const waiting = blocking(room, cfg, ctx, active).map((x) => x.name);
  const away = active.filter((x) => x.away).map((x) => x.name);
  return `${lead}${ready.length ? `Ready: ${ready.join(", ")}. ` : ""}${waiting.length ? `Waiting for: ${waiting.join(", ")}.` : "Nobody is left to wait for."}${away.length ? ` Away: ${away.join(", ")}.` : ""}`;
}

/** The narration answered the round: keep it in the transcript. */
const NOTE_LINE = /^\[.+? \(actors\.[^)]+\)\]\s*PRIVATE\b/;
export function recordRound(room: Room, text: string, narration: string, turn: number, forget = false): void {
  room.idleVotes = []; // a new round: votes about the last blocker are over
  const kept = forget ? text.split("\n").filter((l) => !NOTE_LINE.test(l)).join("\n") : text; // `private.forget`: the private notes were for that round only
  room.history.push({ role: "user", content: kept }, { role: "assistant", content: narration });
  room.rounds = Math.max(room.rounds, turn);
}

// ---------- what does a request carry? ----------

const SECRET = /authorization|cookie|api[-_]?key|token|secret|password/i;
/** MULTIPLAYER_DEBUG: one JSON line per request: which headers and messages Open WebUI sends, and which table the request landed at. */
export function debugRequest(headers: Record<string, unknown>, messages: ChatMessage[], table: string | null): void {
  if (!MULTIPLAYER_DEBUG) return;
  const entry = {
    ts: new Date().toISOString(), table,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SECRET.test(k) ? "[hidden]" : String(v).slice(0, 200)])),
    messages: messages.map((m) => ({ role: m.role, chars: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length, start: typeof m.content === "string" ? m.content.slice(0, 80) : "" })),
  };
  try { fs.mkdirSync(SAVE_DIR, { recursive: true }); fs.appendFileSync(path.join(SAVE_DIR, "multiplayer-debug.jsonl"), JSON.stringify(entry) + "\n"); }
  catch (e) { console.warn("multiplayer debug log failed:", (e as Error).message); }
  console.log(`[multiplayer-debug] table=${table ?? "-"} headers=${Object.keys(entry.headers).filter((h) => h.startsWith("x-")).join(",")} messages=${messages.length}`);
}
