import { AUDIENCE, PRODUCER, SHUFFLE } from "./config.js";
import { record } from "./audit.js";
import { mayProduce } from "./hazards-turn.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

/** Crowd energy after a round (pure): up by the number of lines the audience spoke, down by `decay` when there were none, within 0 and max. */
export function nextEnergy(cur: number, lines: number, max: number, decay: number): number {
  return Math.min(max, Math.max(0, lines > 0 ? cur + lines : cur - decay));
}

/** The lines of a round spoken by seats with the audience role ("[Name (actors.id)] text"). */
export function audienceLines(roundText: string, state: GameState, role: string): number {
  let n = 0;
  for (const l of roundText.split("\n")) { const m = /^\[.+? \(actors\.([^)]+)\)\]\s*(.*)$/.exec(l); if (m && m[2].trim() && !/^(PRIVATE|\(not heard from)/.test(m[2]) && (state.actors[m[1]] as any)?.role === role) n++; }
  return n;
}

/** After a round: write game.audience_energy (server-owned). */
export function audienceRound(state: GameState, roundText: string): GameState {
  if (!AUDIENCE || AUDIENCE.reactions !== "energy") return state;
  const g = state.game as Record<string, unknown>;
  g.audience_energy = nextEnergy(Number(g.audience_energy) || 0, audienceLines(roundText, state, AUDIENCE.role), AUDIENCE.max, AUDIENCE.decay);
  return state;
}

/**
 * What the crowd does to one person's feelings, from their private, locked `suggestible` (-1 to 3, how open they are to peer pressure; unset = 0):
 * 0 unaffected; 1 to 3 the boost applies, sooner (threshold lowered by suggestible - 1) and up to level min(cap, suggestible); -1 digs in (a lift is withheld while the crowd pushes).
 * Returns the cap (positive), -1 (resist) or 0.
 */
export function crowdFor(state: GameState, fromId: string): number {
  const b = AUDIENCE?.boost;
  if (!b) return 0;
  const e = Number((state.game as Record<string, unknown>).audience_energy) || 0;
  const raw = Number((state.actors[fromId] as any)?.suggestible);
  const s = Number.isFinite(raw) ? Math.max(-1, Math.min(3, Math.round(raw))) : 0;
  if (s === 0) return 0;
  if (s < 0) return e >= b.at ? -1 : 0;
  return e >= Math.max(1, b.at - (s - 1)) ? Math.min(b.cap, s) : 0;
}

/** /seat <name> <role>: the producer (by producer.who) puts someone in a seat role: contestant, audience, host... Returns the reply. */
export function seatCommand(arg: string, c: { session: Session; who: PlayerRef }): string {
  const s = c.session, st = s.snapshots.at(-1);
  if (!AUDIENCE || !st) return "";
  if (!mayProduce(s, c.who, "seat")) return `Only the ${PRODUCER.role} (the owner) can assign seats.`;
  const m = /^(.+?)\s+(\S+)$/.exec(arg.trim());
  if (!m) return `Use /seat <name> <role> (${AUDIENCE.seats.join(", ")}).`;
  const role = m[2].toLowerCase();
  if (!AUDIENCE.seats.includes(role)) return `Seats are: ${AUDIENCE.seats.join(", ")}.`;
  const id = Object.entries(st.actors).find(([, a]) => String((a as any)?.name ?? "").toLowerCase() === m[1].toLowerCase())?.[0];
  if (!id) return `Nobody here is called ${m[1]}.`;
  (st.actors[id] as any).role = role;
  return `${m[1]} now sits as ${role}.`;
}

/** /shuffle [step]: runs the next step of the shuffle ritual. Who may: imeng `shuffle.by`. When the last step is done the deck is ready (game.shuffled = 1); the deal then happens when the phase moves on, and the server does the real randomising. */
export function shuffleCommand(arg: string, c: { session: Session; who: PlayerRef }): string {
  const S = SHUFFLE, st = c.session.snapshots.at(-1);
  if (!S || !st) return "";
  const g = st.game as Record<string, unknown>;
  if (S.by === "nobody") return "Shuffling does nothing here: the cards fall where they fall.";
  const role = S.by === "dealer" ? "dealer" : S.by === "host" ? "host" : "";
  const seat = c.session.room?.players?.[c.who.userId]?.actor;
  const mine = !!seat && (st.actors[seat] as any)?.role === role;
  if (!(c.session.owner?.userId === c.who.userId || S.by === "users" || (role && mine))) return `Only the ${role || "table"} shuffles.`;
  if (Number(g.shuffled)) return "The deck is already shuffled.";
  const step = Number(g.shuffle_step) || 0, want = S.ritual[step];
  if (S.ritual.length && !want) return "The deck is already shuffled.";
  if (S.ritual.length) {
    const norm = (x: string): string => x.trim().toLowerCase().replace(/\s+/g, " ");
    if (norm(arg) !== norm(want)) return `Not that: the next step is "${want}" (send /shuffle ${want}).`;
    g.shuffle_step = step + 1;
    record(c.session, "shuffles", `hand ${String(g.hand ?? "?")}: ${c.who.name} ran "${want}"`);
    if (step + 1 < S.ritual.length) return `Done. Next: /shuffle ${S.ritual[step + 1]}.`;
  }
  g.shuffled = 1;
  record(c.session, "shuffles", `hand ${String(g.hand ?? "?")}: deck ready${S.ritual.length ? "" : ` (shuffled by ${c.who.name})`}`);
  return "The deck is shuffled. The deal is ready.";
}
