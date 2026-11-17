import { showdown, VARIANTS, type Variant } from "../tools/poker-eval.js";
import { npcAction, type Roll, serverRoll } from "./poker-npc.js";
import { judgePlay, recordShowdown } from "./poker-sense.js";
import type { GameState } from "./types.js";

/**
 * Fixed-limit betting kept by code (config.json `betting: "server"`), on the same state the narrator used to keep: actors.<id>.chips / bet / status (in, folded, all-in, sitting out),
 * actors.table.pot, game.bet_level (what each player must have in this round), game.current_actor, plus server-owned game.acted, game.raises, game.button.
 * Table settings are read from the state (game.small_blind, big_blind, ante, max_raises), so a room can set them at registration. Pure: every function changes the state it is given and returns text for the table. Side pots: server-owned game.contrib (chips each seat put in this hand) layers the pot at the showdown; an all-in seat wins only what it covered.
 */
const STREETS = ["preflop", "flop", "turn", "river"] as const;
const raiseCap = (s: GameState): number => Math.min(8, Math.max(1, Math.floor(Number(g(s).max_raises)) || 4));
type G = Record<string, any>;
const g = (s: GameState): G => s.game as G;
const nm = (s: GameState, id: string): string => String((s.actors[id] as any)?.name ?? id);
const A = (s: GameState, id: string): Record<string, any> => s.actors[id] as Record<string, any>;
const blinds = (s: GameState): { sb: number; bb: number } => { const bb = Math.max(2, Number(g(s).big_blind) || 10); return { sb: Math.min(bb, Math.max(1, Number(g(s).small_blind) || Math.floor(bb / 2))), bb }; };
const ante = (s: GameState): number => Math.max(0, Math.floor(Number(g(s).ante)) || 0);
/** The fixed bet size: the big blind on the first two streets, double after. */
const size = (s: GameState): number => blinds(s).bb * (["turn", "river"].includes(String(g(s).phase)) ? 2 : 1);

/** Seats in order: everyone with a hole hand who has not folded or sat out, starting after the button. */
const seats = (s: GameState): string[] => Object.keys(s.actors).filter((id) => id !== "table" && (s.actors[id] as any)?.status !== "sitting out" && Array.isArray((s.actors[id] as any)?.hole) && (s.actors[id] as any).hole.length);
const live = (s: GameState): string[] => seats(s).filter((id) => ["in", "all-in"].includes(String(A(s, id).status)));
const canAct = (s: GameState): string[] => seats(s).filter((id) => A(s, id).status === "in");

function put(s: GameState, id: string, amount: number, isAnte = false): number {
  const a = A(s, id), pay = Math.max(0, Math.min(Number(a.chips) || 0, amount));
  a.chips = (Number(a.chips) || 0) - pay; if (!isAnte) a.bet = (Number(a.bet) || 0) + pay;
  const c = (g(s).contrib ??= {}) as Record<string, number>; c[id] = (Number(c[id]) || 0) + pay;
  (s.actors.table as any).pot = (Number((s.actors.table as any).pot) || 0) + pay;
  if (a.chips === 0) a.status = "all-in";
  return pay;
}
function nextAfter(s: GameState, id: string | null): string | null {
  const order = seats(s), start = id ? order.indexOf(id) : -1;
  for (let i = 1; i <= order.length; i++) { const c = order[(start + i + order.length) % order.length]; if (A(s, c).status === "in") return c; }
  return null;
}

/** The hand's first betting round: statuses in, blinds posted, the first to act chosen. Call right after the deal (phase preflop). */
export function startHand(s: GameState, schedule?: { steps: number[]; every: number } | null): string {
  const G = g(s), order = seats(s);
  if (order.length < 2 || !s.actors.table) return "";
  let rose = "";
  const played = Number(G.hands_played) || 0;
  G.hands_played = played + 1;
  if (schedule?.steps.length) {
    if (!G.blind_base) { const b = blinds(s); G.blind_base = { small: b.sb, big: b.bb }; }
    const i = Math.min(schedule.steps.length - 1, Math.floor(played / schedule.every)), m = schedule.steps[i], base = G.blind_base as { small: number; big: number };
    const big = Math.max(2, Math.round(base.big * m)), small = Math.min(big, Math.max(1, Math.round(base.small * m)));
    if (Number(G.blind_level) !== i || Number(G.big_blind) !== big) { if (G.blind_level !== undefined) rose = ` Blinds are now ${small}/${big}.`; G.blind_level = i; G.small_blind = small; G.big_blind = big; }
  }
  for (const id of order) { A(s, id).status = "in"; A(s, id).bet = 0; }
  (s.actors.table as any).pot = 0; G.contrib = {}; G.pots = [];
  G.button = ((Number(G.button) || 0) + 1) % order.length;
  const an = ante(s);
  if (an) for (const id of order) put(s, id, an, true);
  const { sb, bb } = blinds(s);
  const small = order[(G.button + 1) % order.length], big = order[(G.button + 2) % order.length];
  put(s, small, sb); put(s, big, bb);
  G.bet_level = bb; G.raises = 1; G.acted = []; G.last_raiser = null; G.leavers = []; G.weak_raisers = []; G.strong_raisers = [];
  G.current_actor = nextAfter(s, big);
  return `${an ? `Everyone antes ${an}. ` : ""}${nm(s, small)} posts ${sb}, ${nm(s, big)} posts ${bb}.${rose} ${nm(s, String(G.current_actor))} to act.`;
}

export interface Result { ok: boolean; text: string }

/** One action by `id`: check, call, raise, fold or allin. Moves the game on (next player, next street, or the showdown) and says what happened. */
export function act(s: GameState, id: string, action: string, opts: { noSense?: boolean } = {}): Result {
  const G = g(s);
  if (!STREETS.includes(String(G.phase) as any)) return { ok: false, text: "No betting right now." };
  if (G.current_actor !== id) return { ok: false, text: G.current_actor ? `It is ${nm(s, String(G.current_actor))}'s turn.` : "Nobody is to act." };
  const a = A(s, id), level = Number(G.bet_level) || 0, need = Math.max(0, level - (Number(a.bet) || 0));
  let line = "";
  const fits = action === "check" ? need === 0 : action === "call" ? need > 0 : action === "raise" ? (Number(G.raises) || 0) < raiseCap(s) : action === "allin" || action === "fold";
  if (fits && !opts.noSense) judgePlay(s, id, action, Math.max(1, live(s).length - 1)); // the odds are weighed on the cards as they are before the play
  switch (action) {
    case "check": if (need) return { ok: false, text: `You cannot check: it costs ${need} to call.` }; line = `${nm(s, id)} checks.`; break;
    case "call": { if (!need) return { ok: false, text: "Nothing to call: check, or raise." }; const p = put(s, id, need); line = `${nm(s, id)} calls ${p}${a.status === "all-in" ? " and is all-in" : ""}.`; break; }
    case "raise": {
      if ((Number(G.raises) || 0) >= raiseCap(s)) return { ok: false, text: "The betting is capped: call or fold." };
      const target = level + size(s), p = put(s, id, target - (Number(a.bet) || 0));
      if (a.bet > level) { G.bet_level = a.bet; G.raises = (Number(G.raises) || 0) + 1; G.acted = []; }
      line = `${nm(s, id)} ${level ? "raises to" : "bets"} ${a.bet}${a.status === "all-in" ? " and is all-in" : ""}.`; void p; break;
    }
    case "allin": { put(s, id, Number(a.chips) || 0); if (a.bet > level) { G.bet_level = a.bet; G.raises = (Number(G.raises) || 0) + 1; G.acted = []; } line = `${nm(s, id)} is all-in for ${a.bet}.`; break; }
    case "fold": a.status = "folded"; line = `${nm(s, id)} folds.`; break;
    default: return { ok: false, text: "Use check, call, raise, fold or allin." };
  }
  const raised = (Number(a.bet) || 0) > level && (action === "raise" || action === "allin");
  const st = (G.npc_stats ??= {}) as Record<string, { acts: number; raises: number }>, me = (st[id] ??= { acts: 0, raises: 0 });
  me.acts++; if (raised) { me.raises++; G.last_raiser = id; }
  G.acted = [...(Array.isArray(G.acted) ? G.acted : []), id];
  return { ok: true, text: `${line} ${advance(s, id)}`.trim() };
}

function advance(s: GameState, from: string): string {
  const G = g(s), left = live(s);
  if (left.length === 1) return award(s, left, "everyone else folded");
  const level = Number(G.bet_level) || 0, active = canAct(s);
  const settled = active.every((id) => (G.acted as string[]).includes(id) && (Number(A(s, id).bet) || 0) === level);
  if (!settled) { G.current_actor = nextAfter(s, from); return `${nm(s, String(G.current_actor))} to act.`; }
  const i = STREETS.indexOf(String(G.phase) as any);
  if (i === STREETS.length - 1) return showdownNow(s);
  G.phase = STREETS[i + 1]; // the phase hook turns the cards
  for (const id of seats(s)) A(s, id).bet = 0;
  G.bet_level = 0; G.raises = 0; G.acted = []; G.last_raiser = null;
  const order = seats(s), btn = Number(G.button) || 0;
  G.current_actor = null;
  for (let k = 1; k <= order.length; k++) { const c = order[(btn + k) % order.length]; if (A(s, c).status === "in") { G.current_actor = c; break; } }
  if (canAct(s).length < 2) G.current_actor = null; // nobody left to bet against: the streets just run out (see rollOn)
  return G.current_actor ? `On to the ${G.phase}. ${nm(s, String(G.current_actor))} to act.` : `On to the ${G.phase}.`;
}

/** When nobody can bet (all but one all-in), move on one street (or to the showdown); the caller deals the cards between calls. Returns text, or "" when there is nothing to do. */
export function rollOn(s: GameState): string {
  const G = g(s);
  if (G.current_actor || !STREETS.includes(String(G.phase) as any)) return "";
  const i = STREETS.indexOf(String(G.phase) as any);
  if (i === STREETS.length - 1) return showdownNow(s);
  G.phase = STREETS[i + 1];
  return `On to the ${G.phase}.`;
}

/** A seat that left mid-hand is out once the hand is paid. */
function closeHand(s: GameState): void {
  const G = g(s);
  for (const id of Array.isArray(G.leavers) ? (G.leavers as string[]) : []) if (s.actors[id]) A(s, id).status = "sitting out";
  G.leavers = [];
}

function award(s: GameState, winners: string[], why: string): string {
  const G = g(s), pot = Number((s.actors.table as any).pot) || 0, each = Math.floor(pot / winners.length);
  winners.forEach((w, i) => { A(s, w).chips = (Number(A(s, w).chips) || 0) + each + (i === 0 ? pot - each * winners.length : 0); });
  (s.actors.table as any).pot = 0;
  for (const id of seats(s)) A(s, id).bet = 0;
  G.phase = "showdown"; G.current_actor = null; G.bet_level = 0; G.winners = winners; G.pots = [{ amount: pot, winners }]; G.contrib = {}; closeHand(s);
  return `${winners.map((w) => nm(s, w)).join(" and ")} win${winners.length === 1 ? "s" : ""} ${pot} (${why}).`;
}

/** Pot layers from game.contrib: each distinct contribution level is a pot, open to the live seats that covered it. Null when contrib does not add up to the pot (then one pot is used). */
export function layers(s: GameState): { amount: number; eligible: string[] }[] | null {
  const c = (g(s).contrib ?? {}) as Record<string, number>, ids = Object.keys(c).filter((id) => Number(c[id]) > 0);
  if (!ids.length || ids.reduce((n, id) => n + Number(c[id]), 0) !== Number((s.actors.table as any).pot)) return null;
  const alive = live(s), levels = [...new Set(ids.map((id) => Number(c[id])))].sort((a, b) => a - b), out: { amount: number; eligible: string[] }[] = [];
  let prev = 0, carry = 0;
  for (const lv of levels) {
    const amount = ids.reduce((n, id) => n + Math.max(0, Math.min(Number(c[id]), lv) - prev), 0) + carry, eligible = alive.filter((id) => Number(c[id]) >= lv);
    prev = lv;
    if (!eligible.length) { carry = amount; continue; }
    carry = 0; out.push({ amount, eligible });
  }
  if (carry && out.length) out[out.length - 1].amount += carry;
  return out;
}

function showdownNow(s: GameState): string {
  const G = g(s), v = String(G.variant ?? "holdem") as Variant, hands = live(s), variant = VARIANTS.includes(v) ? v : "holdem";
  const board = ((s.actors.table as any).board ?? []) as string[];
  const rank = (ids: string[]) => showdown(variant, board, ids.map((id) => ({ id, hole: A(s, id).hole as string[] })));
  let all;
  try { all = rank(hands); } catch (e) { return `The showdown could not be ranked: ${(e as Error).message}`; }
  const shows = all.map((r) => `${nm(s, r.id)} shows ${(A(s, r.id).hole as string[]).join(" ")}: ${r.name}`).join("; ");
  recordShowdown(s, seats(s), hands); // everyone dealt in sees who raised weak and who raised strong
  const ls = layers(s);
  if (!ls || ls.length < 2) { const win = all.filter((r) => r.winner); return `${shows}. ${award(s, win.map((w) => w.id), win[0].name)}`; }
  const paid: string[] = [], pots: { amount: number; winners: string[] }[] = [], won = new Set<string>();
  try {
    ls.forEach((l, i) => {
      const win = rank(l.eligible).filter((r) => r.winner), ids = win.map((w) => w.id), each = Math.floor(l.amount / ids.length);
      ids.forEach((w, k) => { A(s, w).chips = (Number(A(s, w).chips) || 0) + each + (k === 0 ? l.amount - each * ids.length : 0); won.add(w); });
      pots.push({ amount: l.amount, winners: ids });
      paid.push(`${ids.map((w) => nm(s, w)).join(" and ")} win${ids.length === 1 ? "s" : ""} ${l.amount} from the ${i === 0 ? "main pot" : `side pot ${i}`} (${win[0].name})`);
    });
  } catch (e) { return `The showdown could not be ranked: ${(e as Error).message}`; }
  (s.actors.table as any).pot = 0;
  for (const id of seats(s)) A(s, id).bet = 0;
  G.phase = "showdown"; G.current_actor = null; G.bet_level = 0; G.winners = [...won]; G.pots = pots; G.contrib = {}; closeHand(s);
  return `${shows}. ${paid.join("; ")}.`;
}

/** The house's players: until a real player is to act, an NPC plays by code (poker-npc.ts: a fixed rule, or from its hand and what the table has done when game.npc_aggression is set), so the table never waits on a model. */
export function playNpcs(s: GameState, maxSteps = 24, roll: Roll = serverRoll): string[] {
  const out: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const id = g(s).current_actor as string | null;
    if (!id || !STREETS.includes(String(g(s).phase) as any) || (s.actors[id] as any)?.controlled_by !== "npc") break;
    const want = npcAction(s, id, roll);
    let r = act(s, id, want);
    if (!r.ok && want === "raise") r = act(s, id, (Number(g(s).bet_level) || 0) > (Number(A(s, id).bet) || 0) ? "call" : "check"); // capped
    out.push(r.text);
    if (!r.ok) break;
  }
  return out;
}

/** A player leaves mid-hand. rule "fold" (default): the seat folds, its bet stays in the pot. "split": it stays in for what it has bet (all-in, a side pot). Either way the seat sits out when the hand is paid. Returns text, or "" when there is nothing to do. */
export function leave(s: GameState, id: string, rule: string): string {
  const G = g(s), a = s.actors[id] as Record<string, any> | undefined;
  if (!a || !STREETS.includes(String(G.phase) as any) || !["in", "all-in"].includes(String(a.status))) return "";
  G.leavers = [...(Array.isArray(G.leavers) ? G.leavers : []), id];
  const turn = G.current_actor === id;
  if (rule === "split") {
    if (a.status === "in") a.status = "all-in";
    if (!turn) return `${nm(s, id)} leaves and stays in for ${Number((G.contrib ?? {})[id]) || 0}.`;
    return `${nm(s, id)} leaves and stays in for ${Number((G.contrib ?? {})[id]) || 0}. ${advance(s, id)}`.trim();
  }
  if (a.status === "all-in") return `${nm(s, id)} leaves; the hand is played out for what was bet.`; // an all-in seat has nothing left to act on
  a.status = "folded";
  if (live(s).length === 1) return `${nm(s, id)} leaves and folds. ${award(s, live(s), "everyone else folded")}`;
  return `${nm(s, id)} leaves and folds.${turn ? " " + advance(s, id) : ""}`;
}
