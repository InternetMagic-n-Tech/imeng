import { beginSession, endSession, saveSession, sessions } from "./sessions.js";
import { imageTurn } from "./images.js";
import { linkTurn } from "./identity.js";
import { freezeTurn } from "./freeze.js";
import { LINK, FREEZE, freezeText } from "./identity-config.js";
import { GOALS } from "./goals-config.js";
import { goalCommand } from "./goals-turn.js";
import { OWNER } from "./owner-config.js";
import { ELIGIBILITY, eligibilityText } from "./eligibility-config.js";
import { setFlag } from "./eligibility.js";
import { stateDb } from "./db-state.js";
import { ownerCommand, type OwnerCommand } from "./owner.js";
import { PAY, SEATING } from "./config.js";
import { sitCommand, startCommand } from "./seating.js";
import { BAN, CREDIT, HANDS, HAZARDS, PHASES, AUDIENCE, SHUFFLE, AUDIT, BETTING, MULTIPLAYER, TIPS, PRODUCER } from "./config.js";
import { nudgeCommand } from "./nudge.js";
import { betCommand } from "./poker-bet-turn.js";
import { tipCommand } from "./tips.js";
import { payCommand } from "./pay.js";
import { auditCommand } from "./audit.js";
import { seatCommand, shuffleCommand } from "./audience.js";
import { hazardCommand, phaseCommand } from "./hazards-turn.js";
import { peekCommand, oddsCommand } from "./peek.js";
import { handCommand } from "./hands-private.js";
import { idleVote } from "./idle-vote.js";
import { creditCommand, creditPrivateOnly } from "./credit-turn.js";
import { keepsakeTurn } from "./keepsake.js";
import type { Command } from "./commands.js";
import type { PlayerRef } from "./multiplayer.js";
import type { Sink } from "./sink.js";
import type { ChatMessage, Session } from "./types.js";

/** A chat command (or the yes to a picture offer), before any round starts. Returns true when it answered, which ends the turn. */

export interface CommandCtx { session: Session; key: string; messages: ChatMessage[]; sink: Sink; who: PlayerRef; mp: "solo" | "table" | "private"; tableKey: string | null; now: number }

export async function commandTurn(cmd: Command | null, text: string, c: CommandCtx): Promise<boolean> {
  if (cmd?.name === "link" && LINK) {
    c.sink.canned(await linkTurn(cmd.arg, c.who, c.now));
    return true;
  }
  if ((cmd?.name === "freeze" || cmd?.name === "unfreeze") && FREEZE) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key); // the table's room is shared: take its lock and read its newest copy
    try {
      const s = key === c.key ? c.session : sessions.get(key);
      if (!s) { c.sink.canned(freezeText("solo")); return true; }
      const state = s.snapshots.at(-1)!;
      c.sink.canned(freezeTurn(cmd.name, { session: s, state, who: c.who, arg: cmd.arg, round: s.snapshots.length - 1, now: c.now }));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (ELIGIBILITY?.optIn && (cmd?.name === "optin" || cmd?.name === "optout")) {
    const db = stateDb();
    if (!db || c.who.userId === "anonymous") c.sink.canned(eligibilityText("no_db"));
    else { await setFlag(db, ELIGIBILITY, c.who.userId, ELIGIBILITY.optIn, cmd.name === "optin", c.now); c.sink.canned(eligibilityText(cmd.name === "optin" ? "opted_in" : "opted_out")); }
    return true;
  }
  if (HANDS && BAN && cmd?.name === "peek") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      c.sink.canned(await peekCommand(s, key, c.who, cmd.arg, c.mp === "private", c.now));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (BETTING === "server" && cmd && ["check", "call", "raise", "fold", "allin", "deal"].includes(cmd.name)) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(await betCommand(cmd.name, { session: s, who: c.who })); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (TIPS && cmd?.name === "tip") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(await tipCommand(s, c.who)); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (PAY && cmd?.name === "pay") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(await payCommand(s, c.who, cmd.arg)); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (AUDIT && cmd?.name === "audit") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(await auditCommand(s, c.who)); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (SHUFFLE && cmd?.name === "shuffle") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(shuffleCommand(cmd.arg, { session: s, who: c.who })); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (SEATING?.start && cmd?.name === "start") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(await startCommand(s, c.who)); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (SEATING && cmd?.name === "seat") {
    if (c.mp === "private" || !MULTIPLAYER) { c.sink.canned(SEATING.texts.unseated); return true; } // the owner may seat before anyone else has spoken (the chat is not yet a table)
    c.sink.canned(await sitCommand(c.session, c.key, c.who, cmd.arg, c.now, c.messages));
    return true;
  }
  if (AUDIENCE && cmd?.name === "seat") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(seatCommand(cmd.arg, { session: s, who: c.who })); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (PHASES && (cmd?.name === "move" || cmd?.name === "end")) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      const t = await phaseCommand(cmd.name, cmd.arg, { session: s, who: c.who, signal: `${c.who.userId}:${cmd.name}:${cmd.arg}:${s.snapshots.length}` });
      if (t) c.sink.canned(t);
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (PRODUCER.nudge && cmd?.name === "nudge") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try { const s = key === c.key ? c.session : sessions.get(key) ?? c.session; c.sink.canned(nudgeCommand(cmd.arg, { session: s, who: c.who, shared: c.mp === "table" })); saveSession(key, s); } finally { await endSession(lease); }
    return true;
  }
  if (HAZARDS && (cmd?.name === "risk" || cmd?.name === "shelter")) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      c.sink.canned(hazardCommand(cmd.name, cmd.arg, { session: s, who: c.who, round: s.snapshots.length - 1 }));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (HANDS && BAN && cmd?.name === "odds") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      c.sink.canned(oddsCommand(s, c.who));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (HANDS && cmd?.name === "hand") {
    const s = c.mp === "private" && c.tableKey ? sessions.get(c.tableKey) ?? c.session : c.session;
    c.sink.canned(handCommand(s, c.who, c.mp === "private"));
    return true;
  }
  if (MULTIPLAYER?.idleVote && cmd?.name === "idle") {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      const st = s.snapshots.at(-1)!;
      const tv = st.game[MULTIPLAYER.tokenField.slice(5)];
      const clk = MULTIPLAYER.clock ? Number(st.game[MULTIPLAYER.clock.field.replace(/^(imeng|game)\./, "")]) : NaN;
      c.sink.canned(idleVote(s, c.who, { now: c.now, game: Number.isFinite(clk) ? clk : undefined, token: typeof tv === "string" ? tv : null, field: (a, f) => st.actors[a]?.[f] }));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (CREDIT && (cmd?.name === "reentry" || cmd?.name === "lend" || cmd?.name === "credit" || cmd?.name === "bank" || cmd?.name === "unbank" || cmd?.name === "newcode")) {
    if (c.mp === "table") { c.sink.canned(creditPrivateOnly()); return true; }
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      c.sink.canned(await creditCommand(cmd.name, cmd.arg, { session: s, key, who: c.who, now: c.now }));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (OWNER && (cmd?.name === "owner" || cmd?.name === "successor" || cmd?.name === "claim" || cmd?.name === "keep" || cmd?.name === "handover" || cmd?.name === "telemetry")) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      c.sink.canned(ownerCommand(cmd.name as OwnerCommand, cmd.arg, { session: s, who: c.who, now: c.now }));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if (cmd?.name === "keepsake" && GOALS) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      const s = key === c.key ? c.session : sessions.get(key) ?? c.session;
      c.sink.canned(await keepsakeTurn({ arg: cmd.arg, mp: c.mp, solo: c.session, table: key === c.key ? null : s, userId: c.who.userId }));
      saveSession(key, s);
    } finally { await endSession(lease); }
    return true;
  }
  if ((cmd?.name === "goal" || cmd?.name === "goals") && GOALS) {
    const key = c.mp === "private" && c.tableKey ? c.tableKey : c.key;
    const lease = key === c.key ? null : await beginSession(key);
    try {
      c.sink.canned(goalCommand({ name: cmd.name, arg: cmd.arg, mp: c.mp, solo: c.session, table: key === c.key ? null : sessions.get(key) ?? null, userId: c.who.userId }));
      saveSession(key, key === c.key ? c.session : sessions.get(key) ?? c.session);
    } finally { await endSession(lease); }
    return true;
  }
  return imageTurn(cmd, text, { session: c.session, messages: c.messages, sink: c.sink });
}
