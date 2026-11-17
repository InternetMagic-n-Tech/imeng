import type { Session } from "./types.js";

/**
 * Announcements: something the table or a person must be told (the owner changed, a peek at cards, a re-entry code expires). A typed event is stored with the session; an
 * adapter may register a hook that delivers it its own way (a Discord DM, say) and returns true, which marks it delivered and skips the default. Anything not delivered by a
 * hook is delivered by the default: a line told once with the next reply (`session.own.notices`), or privately for events with a `to`.
 */
export interface AnnounceEvent { id: string; kind: string; from?: string; to?: string; text: string; at: number; delivered?: boolean }
export type AnnounceHook = (e: AnnounceEvent, session: Session) => boolean | Promise<boolean>;

const hooks: AnnounceHook[] = [];
export function onAnnounce(h: AnnounceHook): () => void { hooks.push(h); return () => { const i = hooks.indexOf(h); if (i >= 0) hooks.splice(i, 1); }; }

/** Record an event and try the adapters' hooks; returns it. Never throws. */
export async function announce(session: Session, e: Omit<AnnounceEvent, "id" | "at"> & { at?: number }): Promise<AnnounceEvent> {
  const ev: AnnounceEvent = { ...e, id: `${e.kind}-${(session.announcements?.length ?? 0) + 1}`, at: e.at ?? Date.now() };
  (session.announcements ??= []).push(ev);
  if (session.announcements.length > 100) session.announcements.splice(0, session.announcements.length - 100);
  for (const h of hooks) { try { if (await h(ev, session)) { ev.delivered = true; break; } } catch (err) { console.warn(`announce hook failed: ${(err as Error).message}`); } }
  if (!ev.delivered && !ev.to) { (session.own ??= { created: ev.at, successors: [], people: {}, telemetry: "on", challenge: [], claims: {}, notices: [] }).notices.push(ev.text); ev.delivered = true; }
  return ev;
}

/** Events for one person that no adapter delivered; they are told with their next reply. */
export function takeFor(session: Session, userId: string): string[] {
  const out: string[] = [];
  for (const e of session.announcements ?? []) if (e.to === userId && !e.delivered) { e.delivered = true; out.push(e.text); }
  return out;
}

/** For an adapter that pushes (the Discord bridge): undelivered events addressed to ids with this prefix, across every live session. */
export function pendingFor(all: Iterable<[string, Session]>, prefix: string): { key: string; id: string; to: string; text: string }[] {
  const out: { key: string; id: string; to: string; text: string }[] = [];
  for (const [key, s] of all) for (const e of s.announcements ?? []) if (e.to && !e.delivered && e.to.startsWith(prefix)) out.push({ key, id: e.id, to: e.to, text: e.text });
  return out;
}
/** The adapter delivered these: they are not told again in a reply. */
export function markDelivered(sessions: Map<string, Session>, items: { key: string; id: string }[]): number {
  let n = 0;
  for (const it of items) { const e = sessions.get(it.key)?.announcements?.find((x) => x.id === it.id); if (e && !e.delivered) { e.delivered = true; n++; } }
  return n;
}
