import { seatActor } from "./seats.js";
import { PAY } from "./config.js";
import { gatedPhase, gateText } from "./phases.js";
import { logHand } from "./hand-log.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

/**
 * /pay <name> <amount> (config.json `pay`): a seated real player moves a whole number of `pay.field` (chips) to another seated real player. Code does the sum and the checks
 * (amount, balance, phase, who); a model never moves it. Allowed in `pay.phases` (default: any). Each payment is logged like a tip.
 */
const fill = (t: string, v: Record<string, string | number>): string => t.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const nameOf = (a: Record<string, unknown> | undefined, id: string): string => String(a?.name ?? id);

/** game.escrow: chips held between two players (server-owned: `{from, to, amount}`). Released to the payee, or back to the payer when the payee is gone. Pure; returns the lines. */
type Hold = { from: string; to: string; amount: number };
/** Keep game.escrow and its total (a number, so a phase can use it in enter_when) in step. */
function track(st: GameState, list: Hold[]): void {
  if (list.length) { st.game.escrow = list; st.game.escrow_total = list.reduce((n, h) => n + h.amount, 0); } else { delete st.game.escrow; delete st.game.escrow_total; }
}
export const holds = (st: GameState): Hold[] => (Array.isArray(st.game.escrow) ? (st.game.escrow as Hold[]) : []);
export function releaseEscrow(st: GameState, payer?: string): string[] {
  if (!PAY) return [];
  const T = PAY.texts, out: string[] = [], keep: Hold[] = [];
  for (const h of holds(st)) {
    if (payer && h.from !== payer) { keep.push(h); continue; }
    const to = (st.actors[h.to] ?? st.actors[h.from]) as Record<string, unknown> | undefined, back = !st.actors[h.to];
    if (!to) continue;
    to[PAY.field] = (Number(to[PAY.field]) || 0) + h.amount;
    out.push(fill(back ? T.refunded : T.released, { from: nameOf(st.actors[h.from] as Record<string, unknown>, h.from), to: nameOf(st.actors[h.to] as Record<string, unknown>, h.to), amount: h.amount }));
  }
  track(st, keep);
  return out;
}

export async function payCommand(session: Session, who: PlayerRef, arg: string): Promise<string> {
  const st = session.snapshots.at(-1);
  if (!PAY || !st) return "";
  const T = PAY.texts;
  const players = session.room?.players ?? {};
  const from = seatActor(session, who.userId);
  const payer = from ? (st.actors[from] as Record<string, unknown> | undefined) : undefined;
  if (!from || !payer) return T.seat;
  const sub = PAY.escrow ? /^(release|refund)\s*$/i.exec(arg.trim())?.[1].toLowerCase() : undefined;
  if (sub === "release") { // the payer pays it out early, in any phase (a dance in progress too)
    const lines = releaseEscrow(st, from);
    if (!lines.length) return T.no_escrow;
    await logHand(session, st, "pay", { from, released: true });
    return lines.join(" ");
  }
  const phaseOk = !PAY.phases.length || PAY.phases.includes(String(st.game.phase ?? ""));
  if (sub === "refund") { // before it starts: only where payments are allowed
    if (!phaseOk) return T.refund_late;
    const mine = holds(st).filter((h) => h.from === from);
    if (!mine.length) return T.no_escrow;
    for (const h of mine) payer[PAY.field] = (Number(payer[PAY.field]) || 0) + h.amount;
    track(st, holds(st).filter((h) => h.from !== from));
    await logHand(session, st, "pay", { from, refunded: true });
    return mine.map((h) => fill(T.refunded, { from: nameOf(payer, from), to: "", amount: h.amount })).join(" ");
  }
  const held = gatedPhase(st, "pay");
  if (held) return gateText(held);
  if (!phaseOk) return T.phase;
  const hold = PAY.escrow ? /^hold\s+(.+)$/i.exec(arg.trim()) : null;
  const m = /^(.+?)\s+\$?(\d+)$/.exec((hold ? hold[1] : arg).trim());
  if (!m) return T.usage;
  const amount = Number(m[2]), want = m[1].trim().toLowerCase();
  if (!Number.isSafeInteger(amount) || amount < 1) return T.usage;
  const real = new Set(Object.values(players).map((p) => p.actor));
  const ids = [...real].filter((id) => st.actors[id]);
  const nm = (id: string): string => nameOf(st.actors[id] as Record<string, unknown>, id).toLowerCase();
  const part = ids.filter((id) => nm(id).startsWith(want));
  const to = ids.find((id) => id.toLowerCase() === want) ?? ids.find((id) => nm(id) === want) ?? (part.length === 1 ? part[0] : undefined); // the start of a name works when it is unambiguous
  if (!to) return fill(T.who, { who: m[1].trim() });
  if (to === from) return T.self;
  const have = Number(payer[PAY.field]);
  if (!Number.isFinite(have) || have < amount) return T.poor;
  const payee = st.actors[to] as Record<string, unknown>;
  payer[PAY.field] = have - amount;
  if (hold) {
    track(st, [...holds(st), { from, to, amount }]);
    await logHand(session, st, "pay", { from, to, amount, escrow: true });
    return fill(T.held, { from: nameOf(payer, from), to: nameOf(payee, to), amount });
  }
  payee[PAY.field] = (Number(payee[PAY.field]) || 0) + amount;
  await logHand(session, st, "pay", { from, to, amount, field: PAY.field });
  return fill(T.paid, { from: nameOf(payer, from), to: nameOf(payee, to), amount });
}
