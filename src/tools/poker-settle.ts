/*
 * Paying out a hand in code, with side pots. Everyone's bet goes into the pot, in layers: each layer is the part of the bets up to the next
 * bet size, and only players still contending who put at least that much in can win it. A player who leaves mid-hand (status "left")
 * either folds (`leave_rule` "fold": their bet stays in the pot and they cannot win it) or stays in for what they bet ("split": a side pot,
 * they can win up to what each opponent matched against their bet, and not the rest). Anything a leaver has left, and anything they win,
 * goes to their account (`credit`) for the next game. Going past a stack needs a borrow limit above 0; the shortfall is a negative credit.
 */

export type LeaveRule = "fold" | "split";
export interface Hand { id: string; stack: number; bet: number; status: "in" | "all-in" | "folded" | "left"; credit?: number }
export interface Payout { id: string; payout: number; chips_after: number; credit_after: number; note: string }
export interface Pot { amount: number; eligible: string[]; winners: string[] }

/** `places` ranks the hands (1 = best, ties share a place), as a showdown returns them; a plain `winners` list means place 1 for them and 2 for the rest. */
export function settle(hands: Hand[], winners: string[], opts: { leave_rule?: LeaveRule; borrow_limit?: number; places?: Record<string, number> } = {}): { pot: number; pots: Pot[]; payouts: Payout[] } {
  const rule = opts.leave_rule ?? "fold", limit = Math.max(0, opts.borrow_limit ?? 0);
  if (rule !== "fold" && rule !== "split") throw new Error(`leave_rule is fold or split, not ${rule}`);
  const ids = new Set(hands.map((h) => h.id));
  for (const h of hands) {
    for (const f of ["stack", "bet"] as const) if (!Number.isFinite(h[f]) || h[f] < 0) throw new Error(`${h.id}: ${f} must be a number of zero or more`);
    if (h.bet - h.stack > limit) throw new Error(`${h.id}: bet ${h.bet} is more than stack ${h.stack} plus the borrow limit ${limit}`);
  }
  for (const w of winners) if (!ids.has(w)) throw new Error(`unknown winner: ${w}`);
  const contends = (h: Hand): boolean => h.status === "in" || h.status === "all-in" || (rule === "split" && h.status === "left");
  if (!hands.some(contends)) throw new Error("nobody is left to win the pot");
  const place = (id: string): number => opts.places?.[id] ?? (winners.includes(id) || !winners.length ? 1 : 2);

  const won = new Map<string, number>(hands.map((h) => [h.id, 0]));
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of [...new Set(hands.map((h) => h.bet).filter((b) => b > 0))].sort((a, b) => a - b)) {
    const inLayer = hands.filter((h) => h.bet >= level);
    const amount = (level - prev) * inLayer.length;
    prev = level;
    const eligible = inLayer.filter(contends);
    if (!eligible.length) { for (const h of inLayer) won.set(h.id, won.get(h.id)! + amount / inLayer.length); pots.push({ amount, eligible: [], winners: [] }); continue; } // nobody can win this layer: it goes back to those who put it in
    const best = Math.min(...eligible.map((h) => place(h.id)));
    const win = eligible.filter((h) => place(h.id) === best).map((h) => h.id);
    const each = Math.floor(amount / win.length);
    win.forEach((id, i) => won.set(id, won.get(id)! + each + (i < amount - each * win.length ? 1 : 0)));
    pots.push({ amount, eligible: eligible.map((h) => h.id), winners: win });
  }
  const payouts = hands.map((h): Payout => {
    const got = won.get(h.id)!;
    const total = h.stack - h.bet + got;
    let chips = Math.max(0, total), credit = (h.credit ?? 0) + Math.min(0, total);
    let note = got ? `wins ${got}` : h.status === "folded" ? "folded" : "loses";
    if (h.status === "left") { credit += chips; chips = 0; note = got ? `left, ${got} goes to their account` : "left, the rest of their stack goes to their account"; }
    return { id: h.id, payout: got, chips_after: chips, credit_after: credit, note };
  });
  return { pot: hands.reduce((n, h) => n + h.bet, 0), pots, payouts };
}
