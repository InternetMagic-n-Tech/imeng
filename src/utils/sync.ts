import crypto from "node:crypto";
import { contentText, clone } from "./text.js";
import { initialState } from "./state.js";
import { SYNC } from "./config.js";
import type { SyncConfig } from "./config.js";
import type { ChatMessage, GameState, Session, TurnPrint, AuditEntry } from "./types.js";

/**
 * Keeping the record in step with the conversation. The conversation (what the player can see: Open WebUI's chat, or a transcript a bridge builds) is the
 * source of truth; the saved state is a cache derived from it. So every turn the engine compares the transcript it was sent with a fingerprint it saved,
 * deterministically (no model decides whether the history is intact), and repairs the record when they differ:
 *   - the player went back (regenerated, or edited the latest message): roll back, as before;
 *   - an earlier message was edited, or turns the record never saw arrived: roll back to before it and replay those turns through the extractor, in bounded batches;
 *   - there is no record at all but there is a conversation: rebuild it from the last turns of the transcript, flagged as approximate;
 *   - the record cannot be rebuilt (the extractor keeps failing): say so, and ask the player to try again or start a new chat.
 * Every decision is written to a bounded audit log kept with the session (no message text, only counts and fingerprints), so it can be read later.
 * Modes (config.json sync.mode): off; detect (default: fingerprints and the audit log, nothing is repaired); repair.
 */

export interface Exchange { user: string; narration: string }

const sha = (t: string): string => crypto.createHash("sha1").update(t).digest("hex");
/** Whitespace and Unicode forms do not count as a change. */
export const norm = (t: string): string => t.normalize("NFKC").replace(/\s+/g, " ").trim();
export const userHash = (t: string): string => sha(norm(t)).slice(0, 12);

const words = (t: string): string[] => norm(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

const K = 12; // minhash values per reply
const MUL = [0x9e3779b1, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5, 0xb55a4f09, 0x2545f491, 0x4cf5ad43, 0x7f4a7c15, 0x94d049bb];

/**
 * A MinHash sketch of a reply's word triples (12 values of 24 bits): the share of values two sketches have in common estimates how much of the two texts
 * overlaps, so a reply that was lightly edited is still recognised and a rewritten one is not. Texts under 4 words are compared exactly ("x" + hash).
 */
export function sketch(t: string): string {
  const w = words(t);
  if (w.length < 4) return "x" + sha(w.join(" ")).slice(0, 15);
  const mins = new Array<number>(K).fill(0xffffffff);
  for (let i = 0; i + 3 <= w.length; i++) {
    const seed = parseInt(sha(w.slice(i, i + 3).join(" ")).slice(0, 8), 16);
    for (let k = 0; k < K; k++) {
      let h = Math.imul(seed ^ Math.imul(k + 1, 0x9e3779b1), MUL[k]) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
      h = (h ^ (h >>> 12)) >>> 0;
      if (h < mins[k]) mins[k] = h;
    }
  }
  return mins.map((m) => (m >>> 8).toString(16).padStart(6, "0")).join("");
}

/** Are two sketches of (nearly) the same text? `minShare`: the least share of sketch values that must match (0 to 1). */
export function similar(a: string, b: string, minShare: number): boolean {
  if (a === b) return true;
  if (a[0] === "x" || b[0] === "x" || a.length !== b.length) return false;
  let same = 0;
  for (let i = 0; i < a.length; i += 6) if (a.slice(i, i + 6) === b.slice(i, i + 6)) same++;
  return same / (a.length / 6) >= minShare;
}

/** The completed turns of a transcript (every turn except the pending last user message), as fingerprints and as exchanges for a replay. */
export function transcriptOf(messages: ChatMessage[]): { prints: TurnPrint[]; exchanges: Exchange[] } {
  const chat = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const turns: Exchange[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i].role !== "user") continue;
    const next = chat[i + 1];
    turns.push({ user: contentText(chat[i].content), narration: next?.role === "assistant" ? contentText(next.content) : "" });
  }
  const done = chat.at(-1)?.role === "user" ? turns.slice(0, -1) : turns;
  return { prints: done.map((t) => ({ u: userHash(t.user), a: sketch(t.narration) })), exchanges: done };
}

/** The fingerprints to save after a turn: the completed turns of the request, plus the one just answered. */
export function nextPrints(messages: ChatMessage[], userMsg: string, narration: string): TurnPrint[] {
  return [...transcriptOf(messages).prints, { u: userHash(userMsg), a: sketch(narration) }];
}

export const tipOf = (prints: TurnPrint[] | undefined): string => sha(JSON.stringify(prints ?? [])).slice(0, 12);

export type SyncPlan =
  | { kind: "ok" }
  | { kind: "adopt" }
  | { kind: "back"; from: number; to: number }
  | { kind: "diverged"; at: number; why: "edited" | "behind" }
  | { kind: "rebuild" };

/** How many leading turns of the saved fingerprints agree with the request's. */
export function agree(saved: TurnPrint[], req: TurnPrint[], minShare: number): number {
  let i = 0;
  const n = Math.min(saved.length, req.length);
  while (i < n && saved[i].u === req[i].u && similar(saved[i].a, req[i].a, minShare)) i++;
  return i;
}

/** What the transcript says about the record. `hasRecord`: a saved session exists (it is not new). */
export function planFor(session: Pick<Session, "prints" | "snapshots">, req: { prints: TurnPrint[] }, hasRecord: boolean, minShare: number): SyncPlan {
  const T = req.prints.length; // completed turns in the transcript
  if (!hasRecord) return T > 0 ? { kind: "rebuild" } : { kind: "ok" };
  if (!session.prints) return session.snapshots.length > 1 ? { kind: "adopt" } : { kind: "ok" }; // a record from before fingerprints: trusted as it is
  const n = session.prints.length;
  const common = agree(session.prints, req.prints, minShare);
  if (common < Math.min(n, T)) return { kind: "diverged", at: common + 1, why: "edited" };
  if (T < n) return { kind: "back", from: n, to: T };
  if (T > n) return { kind: "diverged", at: n + 1, why: "behind" };
  return { kind: "ok" };
}

// ---------- the audit log ----------

export function audit(session: Session, e: Omit<AuditEntry, "at" | "tip"> & { at?: number }, keep: number, now = Date.now()): void {
  const log = (session.audit ??= []);
  log.push({ at: e.at ?? now, turn: e.turn, kind: e.kind, detail: e.detail.slice(0, 240), tip: tipOf(session.prints) });
  if (log.length > keep) log.splice(0, log.length - keep);
}

// ---------- repair ----------

export interface ReconcileArgs {
  session: Session;
  messages: ChatMessage[];
  /** The session did not exist before this request. */
  created: boolean;
  /** The turn being answered (user messages in the transcript). */
  turn: number;
  now?: number;
  /** The extractor: state after these exchanges. */
  syncFn: (state: GameState, exchanges: Exchange[]) => Promise<GameState>;
  cfg?: SyncConfig;
}

export interface ReconcileResult {
  /** For the narrator's catch-up block, in plain words. */
  notes: string[];
  /** The record was rebuilt from the transcript (the engine then skips its "record lost" note). */
  rebuilt: boolean;
  /** Answer the player with this instead of playing the turn. */
  refuse?: string;
}

export const REFUSAL = "I can't rebuild this game's record from the conversation right now (the record-keeping model isn't answering). Please try again in a moment; if it keeps failing, start a new chat.";

/**
 * Compare the transcript with the record and, in repair mode, fix the record. Never throws: a failed replay leaves the turns in `session.unsynced` for the
 * next successful extraction.
 */
export async function reconcile(a: ReconcileArgs): Promise<ReconcileResult> {
  const cfg = a.cfg ?? SYNC, s = a.session, now = a.now ?? Date.now();
  const out: ReconcileResult = { notes: [], rebuilt: false };
  if (cfg.mode === "off") return out;
  const req = transcriptOf(a.messages);
  const plan = planFor(s, req, !a.created || s.snapshots.length > 1, cfg.similarity);
  const log = (kind: AuditEntry["kind"], detail: string): void => audit(s, { turn: a.turn, kind, detail }, cfg.auditKeep, now);

  if (plan.kind === "ok") { if (s.abandoned) { delete s.abandoned; log("recovered", "the transcript and the record agree again"); } return out; }
  if (plan.kind === "adopt") { s.prints = req.prints.slice(0, Math.max(0, s.snapshots.length - 1)); log("adopt", `no fingerprints were saved for this record; trusting it as it is (${s.prints.length} turn(s))`); return out; }
  if (plan.kind === "back") {
    log("back", `the player went back from turn ${plan.from} to ${plan.to}; the record is rolled back to match`);
    s.prints = s.prints!.slice(0, plan.to);
    return out; // the engine's rollback does the rest
  }

  // the transcript and the record disagree about turns that were already answered
  const why = plan.kind === "rebuild" ? "there is a conversation but no record" : plan.why === "edited" ? `turn ${plan.at} of the conversation is not what the record was built from (edited or a different branch)` : `the conversation has ${req.prints.length - (s.prints?.length ?? 0)} turn(s) the record never saw`;
  if (cfg.mode === "detect") { log("detected", `${why} (sync.mode is detect: nothing was repaired)`); return out; }

  // ---- repair: roll back to before the first differing turn, replay the rest in batches
  const first = plan.kind === "rebuild" ? 1 : plan.at;
  const total = req.exchanges.length;
  const startTurn = Math.max(first, total - cfg.replayTurns + 1); // older turns than this are not replayed
  const skipped = startTurn - first;
  let base: GameState | undefined = plan.kind === "rebuild" ? undefined : s.snapshots[first - 1];
  for (let i = Math.min(first - 1, s.snapshots.length - 1); i >= 0 && !base; i--) base = s.snapshots[i];
  let state = clone(base ?? initialState());
  s.snapshots.length = Math.min(s.snapshots.length, first);
  if (!s.snapshots.length) s.snapshots.push(clone(state));
  while (s.snapshots.length < first) s.snapshots.push(clone(state));
  for (let t = first; t < startTurn; t++) s.snapshots[t] = clone(state); // turns we did not replay keep the state before them
  const todo = req.exchanges.slice(startTurn - 1);
  let done = startTurn - 1, failed = false, ok = 0;
  for (let i = 0; i < todo.length && !failed; i += cfg.batch) {
    const batch = todo.slice(i, i + cfg.batch);
    try { state = await a.syncFn(state, batch); ok++; }
    catch (e) { failed = true; s.unsynced = todo.slice(i).slice(-10); log("replay-failed", `the extractor failed after ${done - (startTurn - 1)} replayed turn(s): ${(e as Error).message}`); break; }
    for (let t = done + 1; t <= done + batch.length; t++) { const c = clone(state); c.game.turn = t; s.snapshots[t] = c; }
    done += batch.length;
  }
  for (let t = done + 1; t <= total; t++) { const c = clone(state); c.game.turn = t; s.snapshots[t] = c; } // anything not replayed: the last good state
  s.prints = req.prints.slice(0, total);
  s.approximate = skipped > 0 || failed || plan.kind === "rebuild" ? true : s.approximate;
  const replayed = done - (startTurn - 1);
  if (failed) {
    s.syncFailures = (s.syncFailures ?? 0) + (ok === 0 ? 1 : 0);
    if ((s.syncFailures ?? 0) >= 3) { s.abandoned = { at: now, reason: "the record could not be rebuilt" }; log("refused", `the record could not be rebuilt after ${s.syncFailures} attempts`); out.refuse = REFUSAL; return out; }
    out.notes.push(`The record is behind the story (${todo.length - replayed} turn(s) are still to be recorded); rely on the conversation for those.`);
  } else s.syncFailures = 0;
  delete s.abandoned;
  out.rebuilt = plan.kind === "rebuild";
  log(plan.kind === "rebuild" ? "rebuild" : "replay", `${why}: replayed ${replayed} turn(s)${skipped ? `, ${skipped} older turn(s) not replayed` : ""}${failed ? ", the rest is waiting for the extractor" : ""}`);
  out.notes.push(plan.kind === "rebuild"
    ? `The saved record for this chat was lost, so it was rebuilt from the conversation (${replayed} recent turn(s) replayed${skipped ? `, ${skipped} earlier not` : ""}); details may be approximate, so rely on the conversation where they differ.`
    : `The record was corrected to match the conversation (an earlier message changed; ${replayed} turn(s) replayed); details may be approximate.`);
  return out;
}
