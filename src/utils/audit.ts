import { AUDIT } from "./config.js";
import { announce } from "./announce.js";
import type { PlayerRef } from "./multiplayer.js";
import type { GameState, Session } from "./types.js";

/** One line for the house's audit (only kinds the imeng lists in `audit.shows` are kept). Never shown to the table. */
export function record(session: Session | undefined, kind: "deck" | "draws" | "shuffles" | "hands", text: string): void {
  if (!AUDIT || !session || !AUDIT.shows.includes(kind)) return;
  const a = (session.cardLog ??= []);
  a.push(text.slice(0, 300));
  if (a.length > 300) a.splice(0, a.length - 300);
}

/** What the server's deal did, as audit lines (from the operations it applied). */
export function recordDeal(session: Session | undefined, state: GameState, ops: unknown[], to: string): void {
  if (!AUDIT || !session) return;
  const hand = String(state.game.hand ?? "?");
  const name = (id: string): string => String((state.actors[id] as any)?.name ?? id);
  for (const o of ops as { path?: string; value?: unknown }[]) {
    const m = /^actors\.([^.]+)\.(hole|reserve|board)$/.exec(o.path ?? "");
    if (!m || !Array.isArray(o.value)) continue;
    const cards = (o.value as unknown[]).join(" ");
    if (m[2] === "hole" && cards) record(session, "hands", `hand ${hand}: ${name(m[1])} dealt ${cards}`);
    else if (m[2] === "reserve" && to === "preflop") record(session, "deck", `hand ${hand}: board set aside face down: ${cards || "(none)"}`);
    else if (m[2] === "board" && cards) record(session, "draws", `hand ${hand}: ${to} turned, board now ${cards}`);
  }
}

/** /audit: the house reads the cards' record privately; the table is told only that it was sent. */
export async function auditCommand(session: Session, who: PlayerRef): Promise<string> {
  if (!AUDIT) return "";
  if (!session.owner || session.owner.userId !== who.userId) return "Only the house (the owner) can audit.";
  const lines = (session.cardLog ?? []).slice(-60);
  await announce(session, { kind: "audit", to: who.userId, text: lines.length ? `Audit (latest):\n${lines.join("\n")}` : "Audit: nothing recorded yet." });
  return "The audit was sent to the house privately.";
}
