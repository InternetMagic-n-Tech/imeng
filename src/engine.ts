import { parseDurationMs } from "./utils/durations.js";
import { MODEL, SYSTEM_PROMPT, REASONING, DICE, STATE_NOTES, TAIL_NOTICES, WRAP_UP, EARLY_SYNC, MULTIPLAYER, ACTOR_TEMPLATE, KNOWLEDGE, CONTEXT_MAX_TOKENS, TOO_LONG_REPLY, PRIVATE_ONLY_REPLY, USER_ID } from "./utils/config.js";
import { attachActive, captureAttachments, captureBytes, parseDataUri } from "./utils/attachments.js";
import { dbg } from "./utils/debug.js";
import { clone, contentText, isBackgroundTask, withTail } from "./utils/text.js";
import { reqCtx, holdLogs, releaseLogs } from "./utils/logger.js";
import { scrubNameMessages, Restorer } from "./utils/pii-names.js";
import { asksWhatThisIs, introText } from "./utils/catalog.js";
import { finishTrace, traceIO, stageSpan } from "./utils/mlflow.js";
import { sessions, sessionFor, saveSession, hydrate, beginSession, endSession } from "./utils/sessions.js";
import type { Lease } from "./utils/sessions.js";
import { interfaceContext } from "./utils/sink.js";
import type { Sink, Inbound } from "./utils/sink.js";
import type { Promote } from "./utils/sessions.js";
import { playerOf, newRoom, join as joinRoom, adoptChat, step as roomStep, syncPlayers, recordRound, leaveTable, addNote, debugRequest } from "./utils/multiplayer.js";
import { seat, seatOf, unseat, loadSeats } from "./utils/seats.js";
import { judgeMessage, needsJudge } from "./utils/room-judge.js";
import { privateTurn, tensionBeat } from "./utils/table.js";
import type { Step, StepCtx, Verdict } from "./utils/multiplayer.js";
import { stateBlock, diceBlock, stateNotes } from "./utils/state.js";
import { syncState, deliverText } from "./utils/upstream.js";
import { toolsOn, narrateWithTools } from "./utils/tools.js";
import { rollbackKnowledge, markAnnounced } from "./utils/knowledge.js";
import { knowledgeFor, checkTriggers, covertActs } from "./utils/knowledge-judge.js";
import { privateNarration } from "./utils/private-narration.js";
import { narrateOnce, holdsReply, guardNarration } from "./utils/knowledge-turn.js";
import { reconcile, nextPrints, audit as auditLog } from "./utils/sync.js";
import { AUDIENCE, HAZARDS, HANDS, CREDIT, MODEL_ID, BAN, RANDOM_EVENTS, DATING, DECK, NAMING, RULING, VOICES, SHOW_CLOCK, IMENGS_ROOT, OFF_PHASE, SYNC, MLFLOW_PER_CHAT, BETTING, TIPS, FORFEIT, SEATING, TERMS } from "./utils/config.js";
import { chatExperimentId } from "./utils/mlflow-chat.js";
import { decideMode, judgeRules, auditRules } from "./utils/judge.js";
import { analyzeSetup, inSetupWindow } from "./utils/setup.js";
import { applySummary, maybeCompact } from "./utils/compact.js";
import { wrapUpStatus } from "./utils/wrapup.js";
import { estimateTokens } from "./utils/compact.js";
import { runGameTurn, turnBlock } from "./utils/game-turn.js";
import { crossNow } from "./utils/crossings.js";
import { evalCondition, type Condition } from "./utils/conditions.js";
import { drawOne, cardName, multiplier, freshDeck, handsRound, alignmentOf, combine, classAlignment, type Card } from "./utils/deck.js";
import { ensureNotes, revealRound, factsBlock } from "./utils/dating-facts.js";
import { guardReveal, guardViewer } from "./utils/peek.js";
import { noteSpoken } from "./utils/tone.js";
import { announce } from "./utils/announce.js";
import { remember } from "./utils/lend-confirm.js";
import { creditRound, anteRound } from "./utils/credit-turn.js";
import { takeFor } from "./utils/announce.js";
import { recordTokens } from "./utils/pii-store.js";
import { audienceRound } from "./utils/audience.js";
import { runPhaseHook } from "./utils/phase-hook.js";
import { rollEvents, eventsBlock, rollHazards } from "./utils/random-events.js";
import { nudgeBlock } from "./utils/nudge.js";
import { sendTerms } from "./utils/terms.js";
import { debrief, rollTraits } from "./utils/knowledge.js";
import { senseBlock } from "./utils/poker-sense.js";
import { rollForfeit, answerForfeit, hasImage } from "./utils/forfeit.js";
import { ban, bannedUntil } from "./utils/bans.js";
import { rule, rulingBlock, ruleRound } from "./utils/ruling.js";
import { voicesBlock } from "./utils/voices.js";
import { timeJump } from "./utils/show-clock.js";
import { nameActors, refillPool, poolBlock } from "./utils/naming.js";
import { datingRound, finaleRound } from "./utils/dating-turn.js";
import { phaseBlock } from "./utils/phases.js";
import { toneBlock } from "./utils/state.js";
import { isOffPhase, pickOffPhase, askedGate } from "./utils/gate.js";
import { GOALS } from "./utils/goals-config.js";
import { storeOf as goalStore, syncCounts, rollbackGoals, consumedSkip, narratorBlock as goalsBlock } from "./utils/goals.js";
import { goalsRound, takeReveal, captureNote } from "./utils/goals-turn.js";
import { foldPrivate, privateBlock, splitPrivate, PRIVATE_LINE } from "./utils/private-input.js";
import { foldCommands } from "./utils/commands.js";
import { syncCandidates, ensureOwnership, ownerNotice, telemetryOn, closedReply } from "./utils/owner.js";
import { stateNow, unavailableText, stateDb } from "./utils/db-state.js";
import { rehydrateIn, rehydrateOut } from "./utils/rehydrate-run.js";
import { ELIGIBILITY } from "./utils/eligibility-config.js";
import { getMask, joinRefusal } from "./utils/eligibility.js";
import { PII_FILTER } from "./utils/pii-filter-config.js";
import { piiText } from "./utils/pii-filter-config.js";
import { scrubMessages, summary as piiSummary } from "./utils/pii-filter.js";
import { OWNER } from "./utils/owner-config.js";
import { seatQueued, photoTurn, purgePhotos } from "./utils/seating.js";
import { imagesOf } from "./utils/seat-photo.js";
import { removeImage } from "./utils/image-store.js";
import { commandTurn } from "./utils/command-turn.js";
import { canonicalPlayer, loadLinks, rekeyRoom } from "./utils/identity.js";
import { LINK, FREEZE, freezeText } from "./utils/identity-config.js";
import { autoFold, leaveSeat } from "./utils/poker-bet-turn.js";
import { trimHandLog } from "./utils/hand-log.js";
import { tipsAfterTurn, tipNote } from "./utils/tips.js";
import { worldBlock } from "./utils/world.js";
import { frozenBlock, applyControl } from "./utils/freeze.js";
import type { ChatMessage, GameState, Session } from "./utils/types.js";

/*
 * The engine: one turn of a game, independent of how the message arrived. An interface module (modules/openwebui, ...) turns its platform's
 * message into an Inbound, gives the engine a Sink to answer through, and the engine does the rest: session, table or private chat, prompt,
 * narrator, state update. See modules/index.ts.
 */

async function handleTurn(req: Inbound, sink: Sink): Promise<void> {
  const store = reqCtx.getStore()!;
  store.user = req.get("x-openwebui-user-id") || undefined; // for traces (Open WebUI sends it when ENABLE_FORWARD_USER_INFO_HEADERS is on)
  let messages: ChatMessage[] = req.body.messages || [];
  const body: Record<string, unknown> = { ...req.body, model: MODEL };
  if (REASONING === "off") body.reasoning_effort = "none";

  try {
    if (isBackgroundTask(messages)) {
      // Open WebUI's title/tag requests: logged only if they belong to a known game chat.
      const cid = req.get("x-openwebui-chat-id");
      store.session = cid ? "chat:" + cid : "";
      store.mode = (cid && sessions.get("chat:" + cid)?.mode) || "";
      return await sink.passthrough(body);
    }

    let piiTokens: string[] = [];
    if (PII_FILTER) { // personal details are tokenised (or the message refused) before anything else reads the messages
      const scrubbed = scrubMessages(messages);
      if (Object.keys(scrubbed.found).length) {
        console.log(`[pii] ${PII_FILTER.onDetect}: ${piiSummary(scrubbed.found)}`);
        dbg("pii")("%s: %s", PII_FILTER.onDetect, piiSummary(scrubbed.found));
        if (PII_FILTER.onDetect === "block" && scrubbed.messages.some((m, i) => m !== messages[i] && m.role === "user" && i === scrubbed.messages.length - 1)) { sink.canned(piiText("blocked")); return; }
        if (PII_FILTER.onDetect === "mask") messages = scrubbed.messages;
      }
      if (PII_FILTER.names) { // names, relations, animals and sensitive facts: found by the small judge model, decided and tokenised in code
        try {
          const n = await scrubNameMessages(messages);
          messages = n.messages;
          piiTokens = [...n.table.keys()];
          if (PII_FILTER.restore && n.table.size) store.piiRestore = new Restorer(n.table); // the player sees real names again in the reply; secrets are never in this table
          if (n.found) console.log(`[pii] names masked: ${n.found}`);
        } catch (e) { // refuse rather than let an unchecked message through, and leave a line to review (no message text in it)
          console.warn(`[pii] REVIEW: the name detector failed, message refused (${(e as Error).message})`);
          dbg("pii")("detector failed: %s", (e as Error).message);
          sink.canned(piiText("detector_failed")); return;
        }
      }
    }
    // Shared games (config.json: multiplayer): a chat shared with "Allow replies" (or a channel) is a table; a seated person's new chat is their private channel.
    let userText = contentText(messages.filter((m) => m.role === "user").at(-1)?.content);
    let key: string, session: Session, promote: Promote | null, created: boolean;
    [key, session, promote, created] = sessionFor(req, messages);
    if (piiTokens.length) void recordTokens(key, piiTokens); // the hashes (never the names) this chat uses, in the long-term store
    const sentImage = hasImage(messages.filter((m) => m.role === "user").at(-1)?.content); // before any capture swaps the bytes for a placeholder
    const rawPics = SEATING?.photo ? imagesOf(messages.filter((m) => m.role === "user").at(-1)?.content, parseDataUri) : []; // the seat picture, same moment
    const cmds = foldCommands(messages); // /draw, /portrait and "yes" to a picture offer are notes, not rounds
    messages = cmds.messages;
    userText = contentText(messages.filter((m) => m.role === "user").at(-1)?.content);
    if (session.privateFor) await hydrate(session.privateFor);
    if (LINK && session.room) rekeyRoom(session.room); // an account linked since the table last met // Redis mode: the table this chat belongs to may be newer elsewhere
    if (LINK) await loadLinks();
    const real = (p: { userId: string }): boolean => p.userId !== "anonymous";
    const who = canonicalPlayer(playerOf((h) => req.get(h))); // linked accounts are one person
    if (attachActive()) { // a picture someone attached (that we did not make) is kept; the models see "[image:<id>]", never the bytes
      const cap = await captureAttachments(messages, { session: key, userId: who.userId === "anonymous" ? undefined : who.userId, source: "openwebui" });
      messages = cap.messages;
      const ids = cap.saved.map((s) => s.id);
      const att = cmds.latest && "attached" in cmds.latest ? cmds.latest.attached : undefined;
      const parsed = att ? parseDataUri(att) : null;
      if (parsed) { const s = await captureBytes(parsed.bytes, parsed.mime, { session: key, userId: who.userId === "anonymous" ? undefined : who.userId, source: "openwebui" }); if (s) ids.push(s.id); }
      if (ids.length) { store.attachments = [...new Set(ids)]; dbg("engine")("attachments kept: %s", store.attachments.join(", ")); }
    }
    let mp: "solo" | "table" | "private" = "solo";
    let tableKey: string | null = null;
    if (MULTIPLAYER && who.userId !== "anonymous") {
      await loadSeats();
      if (session.room) mp = "table";
      else if (session.privateFor && sessions.get(session.privateFor)?.room) { mp = "private"; tableKey = session.privateFor; }
      else if (session.mode === "game" && session.owner && session.owner.userId !== who.userId) mp = "table"; // a second person speaks here: it is a table now
      else if (created && MULTIPLAYER.priv) { // a new chat of someone seated at a table is their private channel
        const t = seatOf(who.userId, Date.now(), MULTIPLAYER.seatMs);
        if (t) await hydrate(t);
        if (t && t !== key && sessions.get(t)?.room) { mp = "private"; tableKey = t; session.privateFor = t; }
      }
      debugRequest(req.headers, messages, mp === "private" ? tableKey : mp === "table" ? key : null);
    }
    if (FORFEIT && sentImage && who.userId !== "anonymous" || FORFEIT && sentImage && mp === "solo") { // the person owed a picture sent one: the forfeit is paid (the picture is never read by a model)
      const ts = mp === "private" && tableKey ? sessions.get(tableKey) : session, snap = ts?.snapshots.at(-1);
      const line = ts && snap ? answerForfeit(snap, ts.room?.players?.[who.userId]?.actor ?? USER_ID) : "";
      if (ts && line) { (ts.pendingEvents ??= []).push({ round: messages.filter((m) => m.role === "user").length - 1, text: line }); saveSession(mp === "private" && tableKey ? tableKey : key, ts); }
    }
    // <private> in what the player wrote: a private-only message is a note and starts no round (it, and the reply after it, leave the conversation).
    let fold = mp === "private" ? null : foldPrivate(messages, mp === "solo", GOALS ? consumedSkip(session.goals) : undefined);
    if (GOALS && fold?.latest.length && mp === "solo" && session.snapshots.length && !(session.wrapUp !== undefined)) { // a private part of a solo message may be a goal: kept as one, and then not shown to the narrator
      const state = session.snapshots.at(-1)!;
      const reply = await captureNote({ table: session, actor: USER_ID, text: fold.latest.join("\n"), parts: fold.latest, state, pub: splitPrivate(contentText(messages.filter((m) => m.role === "user").at(-1)?.content)).pub });
      if (reply !== null) {
        fold = foldPrivate(messages, true, consumedSkip(session.goals));
        if (fold.latestOnly) { saveSession(key, session); sink.canned(reply); return; } // a note that was only a goal: it starts no round
      }
    }
    if (fold) { messages = fold.messages; userText = contentText(messages.filter((m) => m.role === "user").at(-1)?.content); }
    store.session = key;
    if (session.own) store.telemetry = telemetryOn(session); // the owner may have turned telemetry off for this chat
    if (MLFLOW_PER_CHAT && store.telemetry !== false) store.experimentId = (await chatExperimentId(key, MODEL)) ?? undefined; // each chat its own MLflow experiment (off by default)
    const prev = session.tail; // requests for one session run one at a time
    let release!: () => void;
    session.tail = new Promise<void>((r) => (release = r));
    await prev;

    try {
      if (mp === "private" && MULTIPLAYER && tableKey && who) { const tbl = sessions.get(tableKey); if (tbl) { const plain = sink.canned.bind(sink); const uid = who.userId; sink.canned = (x: string) => { const m = takeFor(tbl, uid); plain(m.length ? x + "\n\n" + m.join("\n") : x); }; } } // what the house has for this person (a re-entry code, a tip offer) rides on their private replies, commands included, and nowhere else
      if (SEATING?.photo && mp !== "private") { // a seat picture: checked by code (one person, safe for work), then the confirmation is finished; old photos are purged
        purgePhotos(session, Date.now(), removeImage);
        const r = rawPics.length ? await photoTurn(session, key, who, rawPics, Date.now(), messages) : null;
        if (r !== null) { saveSession(key, session); sink.canned(r); return; }
      }
      if (await commandTurn(cmds.latest, userText, { session, key, messages, sink, who, mp, tableKey, now: Date.now() })) { if (SEATING && mp !== "private") await seatQueued(session, key, Date.now(), messages); saveSession(key, session); return; }
      const clockOf = (st: GameState): number | undefined => { const v = MULTIPLAYER?.clock ? Number(st.game[MULTIPLAYER.clock.field.slice(5)]) : NaN; return Number.isFinite(v) ? v : undefined; };
      // A private chat: a note to the narrator from someone seated at a table. It never starts a round.
      if (mp === "private" && MULTIPLAYER && tableKey) {
        const tableLease = await beginSession(tableKey); // the table's room is shared: take its lock (Redis mode) and read its newest copy
        try {
          const table = sessions.get(tableKey);
          if (!table?.room) { sink.canned("That table is not available right now. Speak at it again, then try this chat."); return; }
          if (LINK) rekeyRoom(table.room);
          const latest = table.snapshots.at(-1)!;
          await privateTurn({ sink, who, text: userText, session, table, cfg: MULTIPLAYER, now: Date.now(), game: clockOf(latest), state: latest });
          saveSession(tableKey, table);
          saveSession(key, session);
        } finally { await endSession(tableLease); }
        return;
      }
      if (fold?.latestOnly) {
        const t = session.snapshots.at(-1);
        if (mp === "table" && MULTIPLAYER?.priv && t && session.room) {
          let seated = !!session.room.players[who.userId];
          if (!seated && MULTIPLAYER.priv.unseated === "seat" && joinRoom(session.room, who, MULTIPLAYER, Date.now())) { await seat(who.userId, key, Date.now()); seated = true; }
          if (seated) {
            await privateTurn({ sink, who, text: fold.latest.join("\n"), session, table: session, cfg: MULTIPLAYER, now: Date.now(), game: clockOf(t), state: t });
            saveSession(key, session);
            return;
          }
        }
        sink.canned(PRIVATE_ONLY_REPLY);
        return;
      }
      // A table: what the players say is collected by the turn policy; a round is narrated once for all of them.
      let round: Step | null = null;
      if (mp === "table" && MULTIPLAYER) {
        const room = (session.room ??= newRoom());
        room.notes ??= [];
        store.user = who.userId;
        if (SEATING && !room.players[who.userId]) { sink.canned(SEATING.texts.unseated); return; } // watching: not a player until /seat
        if (room.order.length === 0) { // the chat becomes a table: the story so far is the room's transcript, and the first person to speak is player one
          if (!SEATING && session.owner && session.owner.userId !== who.userId) { joinRoom(room, session.owner, MULTIPLAYER, Date.now()); await seat(session.owner.userId, key, Date.now()); }
          adoptChat(room, messages.slice(0, -1));
        }
        const now = Date.now();
        const db = stateDb();
        if (ELIGIBILITY && db && who.userId !== "anonymous" && !room.players[who.userId] && session.owner?.userId !== who.userId) { // joining needs the flags
          const refusal = joinRefusal(ELIGIBILITY, await getMask(db, ELIGIBILITY, who.userId, now));
          if (refusal) { sink.canned(refusal); return; }
        }
        if (BAN && HANDS) { // what a hand is worth is never said in the shared chat; someone who only watched may not say what they saw or join the hand
          const refused = (await guardViewer(session, key, who, userText, now)) ?? (await guardReveal(session, key, who, userText, now));
          if (refused) { if (refused.kick) sink.header?.("x-imeng-kick", `${refused.kick.userId};${refused.kick.until}`); saveSession(key, session); sink.canned(refused.text); return; }
        }
        const me = joinRoom(room, who, MULTIPLAYER, now);
        if (!me) { sink.canned("This table is full."); return; }
        if (TERMS && !SEATING) await sendTerms(session, who, now); // a new person at a table without seats: the terms, privately
        if (CREDIT && session.owner && session.owner.userId === who.userId && userText && !userText.startsWith("/")) remember(session, userText); // the owner's long words, for confirming loans
        if (me.frozen) { sink.canned(freezeText("you_are_frozen")); return; } // a frozen player is not heard until /unfreeze
        const goalNote = GOALS && fold?.latest.length && session.snapshots.length && session.wrapUp === undefined // the private part of a spoken message may be a goal (silently: the round goes on)
          ? await captureNote({ table: session, actor: me.actor, text: fold.latest.join("\n"), parts: fold.latest, state: session.snapshots.at(-1)!, pub: splitPrivate(userText).pub }) : null;
        if (goalNote === null && fold?.latest.length && MULTIPLAYER.priv?.narratorSees) addNote(room, who.userId, fold.latest.join("\n")); // the private part of a spoken message
        await seat(who.userId, key, now);
        const latestState = session.snapshots.at(-1)!;
        if (MULTIPLAYER.leave.test(userText.trim())) {
          leaveTable(room, who.userId, { now, game: clockOf(latestState) });
          await unseat(who.userId);
          const hand = BETTING === "server" && session.mode === "game" ? await leaveSeat(session, me.actor) : ""; // a leaver mid-hand folds or stays in for what they bet, in code
          saveSession(key, session);
          sink.canned(`${me.name} has left the table.${hand ? " " + hand : ""}`);
          return;
        }
        if (MULTIPLAYER.silencedWhen && latestState.actors[me.actor] && evalCondition(MULTIPLAYER.silencedWhen as Condition, latestState, latestState.actors[me.actor])) { // the dead say nothing the living can hear
          saveSession(key, session);
          sink.canned(MULTIPLAYER.silencedReply);
          return;
        }
        if (BAN) { // a banned player is ignored: not read, not dealt, not heard in the private channel
          const until = await bannedUntil(session, key, who.userId, now);
          if (until) { saveSession(key, session); sink.canned(BAN.text.replace(/\{time\}/g, new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC")); return; }
        }
        const notAsked = askedGate(latestState, me.actor);
        if (notAsked) { saveSession(key, session); sink.canned(notAsked); return; } // not the one asked: it stays in the chat and changes nothing
        const tokenV = latestState.game[MULTIPLAYER.tokenField.slice(5)];
        let verdict: Verdict | null = null;
        if (needsJudge(room, MULTIPLAYER)) verdict = await judgeMessage(room, MULTIPLAYER, { text: userText, secret: "", narration: String(room.history.filter((m) => m.role === "assistant").at(-1)?.content ?? ""), me });
        const ctx: StepCtx = { now, game: clockOf(latestState), defaultRealMs: MULTIPLAYER.defaultAfterField ? (parseDurationMs(String(latestState.game[MULTIPLAYER.defaultAfterField.slice(5)] ?? "")) ?? undefined) : undefined, token: typeof tokenV === "string" ? tokenV : null, verdict, field: (actor, f) => latestState.actors[actor]?.[f], silenced: (actor) => !!(MULTIPLAYER?.silencedWhen && latestState.actors[actor] && evalCondition(MULTIPLAYER.silencedWhen as Condition, latestState, latestState.actors[actor])) };
        const st = roomStep(room, who, userText, MULTIPLAYER, ctx);
        if (!st) { sink.canned("This table is full."); return; }
        if (st.kind === "reply") {
          const beat = await tensionBeat(room, MULTIPLAYER, st.hold, now); // optional: the narrator's one short line instead of the terse status
          saveSession(key, session);
          sink.canned(beat ?? st.text);
          return;
        }
        round = st;
        messages = st.messages;
        session.mode = "game";
      } else if (MULTIPLAYER && who.userId !== "anonymous" && !session.owner) session.owner = who; // the first person to speak here (a second one makes it a table)
      const turn = messages.filter((m) => m.role === "user").length;
      store.turn = turn;
      const userMsg = contentText(messages.filter((m) => m.role === "user").at(-1)?.content);

      // The first message decides: game mode (state, rules, narrator) or direct mode (plain proxy).
      // The mode is re-derived from the chat's first message when unknown (e.g. after a restart,
      // since direct chats are never saved).
      if (!round && (turn === 1 || !session.mode)) {
        const first = contentText(messages.find((m) => m.role === "user")?.content);
        holdLogs(); // don't log anything until we know this is a game
        const tMode = Date.now();
        try { session.mode = await decideMode(first); }
        finally { store.mode = session.mode ?? ""; releaseLogs(session.mode === "game"); }
        stageSpan(store, "invocation", tMode);
      }
      store.mode = session.mode!;
      if (session.mode === "game" && !(await stateNow()).ok) { sink.canned(unavailableText()); return; } // the stamp is wrong: no turn is played
      if (session.mode === "game" && real(who)) {
        ensureOwnership(session, who, Date.now());
        if (OWNER) void syncCandidates(session, key, MODEL_ID);
        if (OWNER?.tone && userText && !userText.startsWith("/")) await noteSpoken(session, who, userText, Date.now()); // opt-in tone rating for successors
        store.telemetry = telemetryOn(session);
        const closed = OWNER ? closedReply(session) : null;
        if (closed) { sink.canned(closed); saveSession(key, session); return; }
      }
      // A game chat whose saved state is gone (e.g. data wiped): say so. Direct chats are never saved, so no warning.
      if (created && turn > 1 && session.mode === "game") console.warn(`No saved game for ${key}; starting fresh mid-conversation.`);
      if (session.mode === "direct") {
        // No launch word, but they ask what this is: tell them, from the imengs folder, with no model call.
        if (turn === 1 && asksWhatThisIs(userMsg)) { sink.canned(await introText(IMENGS_ROOT)); return; }
        // Plain pass-through: nothing is saved to disk and nothing is logged to Redis.
        const out = await sink.relay(body, "direct");
        if (promote) key = promote(out);
        return;
      }

      // The conversation is the truth and the record a cache: check they still match (utils/sync.ts) and, in repair mode, fix the record before the turn is played.
      let synced: { notes: string[]; rebuilt: boolean } = { notes: [], rebuilt: false };
      if (!round) {
        const tSync = Date.now();
        const r = await reconcile({ session, messages, created, turn, syncFn: syncState });
        if (r.rebuilt || r.notes.length) stageSpan(reqCtx.getStore(), "sync.repair", tSync, { rebuilt: r.rebuilt, notes: r.notes.length });
        if (r.refuse) { sink.canned(r.refuse); saveSession(key, session); return; }
        synced = r;
      }
      // When the story and the record may be out of step, the narrator gets a catch-up in plain words.
      const catchUp: string[] = [...synced.notes];
      if (created && turn > 1 && !synced.rebuilt) catchUp.push("The saved record for this chat was lost, so it starts again from the beginning; rely on the conversation for anything the record doesn't show yet.");
      if (session.snapshots.length > turn) catchUp.push("The player went back (regenerated or edited), so the record was rolled back to match.");
      else if (session.unsynced.length) catchUp.push(`The record is ${session.unsynced.length} turn(s) behind the story (the bookkeeping failed); rely on the conversation for those.`);

      // Roll back if the user regenerated/edited; fill gaps with the latest state.
      if (session.snapshots.length > turn) session.unsynced = [];
      if (KNOWLEDGE && session.knowledge && session.snapshots.length > turn) rollbackKnowledge(session.knowledge, KNOWLEDGE, turn); // what came out on a replayed turn is hidden again
      if (GOALS && session.goals && session.snapshots.length > turn) rollbackGoals(session.goals, turn); // a goal reached on a replayed round is open again
      if (session.deckAt && session.snapshots.length > turn) { // the cards go back with the record: the deck as it was when this turn began
        session.deck = session.deckAt[turn] ? structuredClone(session.deckAt[turn]!) : undefined;
        for (const k of Object.keys(session.deckAt)) if (Number(k) >= turn) delete session.deckAt[Number(k)];
      }
      if (session.snapshots.length > turn) await trimHandLog(session, turn); // the house's copy of the hands after this turn goes with them
      session.snapshots.length = Math.min(session.snapshots.length, turn);
      // A chat that began mid-conversation has gaps in its snapshots: use the latest one that exists.
      let latest = session.snapshots.at(-1);
      for (let i = session.snapshots.length - 1; i >= 0 && !latest; i--) latest = session.snapshots[i];
      if (round && session.room) syncPlayers(latest!, session.room, ACTOR_TEMPLATE as Record<string, unknown>); // every player has an actor, never an NPC
      if (round && BETTING === "server" && session.mode === "game") { const n = await autoFold(session, round.text); if (n) { latest = session.snapshots.at(-1); messages = messages.map((m, i) => (i === messages.length - 1 ? { ...m, content: `${contentText(m.content)}\n${n}` } : m)); } } // shot clock: the server folds
      if (FREEZE && latest) applyControl(latest, session); // npc mode: a frozen player is played as an NPC meanwhile
      if (GOALS) syncCounts(latest!, goalStore(session)); // the counters follow the store (a rolled-back round forgets what it reached)
      if (session.mode === "game" && latest) catchUp.push(...(await rehydrateIn(session, latest, who))); // what the database holds for the people here, and what changed while they were away
      dbg("engine")("turn %d, mode %s, phase %s", turn, session.mode, latest?.game.phase);
      if (session.mode === "game" && latest) catchUp.push(...crossNow(latest)); // a crossing is due: the server rolls the ambient, moves the place and the phase
      const before = clone(latest!);
      before.game.turn = turn;

      const { messages: shown, recap } = applySummary(messages, session, turn);
      // A rule the judge caught being broken in the previous reply is put to the narrator once, as a correction.
      const v = session.violations;
      const violations = v && v.turn === turn - 1
        ? `\n\n## RULE VIOLATION (your last reply broke a standing rule)\n${v.items.map((i) => `- ${before.game.rules[i.id]?.text ?? i.id}\n  You wrote: "${i.quote}" (${i.reason})`).join("\n")}\nPut it right in this reply, in the story's own voice and without mentioning this notice, and keep the rule from now on.`
        : "";
      // A catch-up (the record was rolled back, rebuilt or is behind) always reaches the narrator, with or without state_notes.
      const catchOnly = (c: string[]): string => `\n\n## CATCH-UP (written by the server)\n${c.map((x) => `- ${x}`).join("\n")}\nTrust the record in the JSON state over any conflicting detail you half-remember, and carry on without mentioning the catch-up.`;
      // Facts only some people know: the narrator holds one only on a round where a knower speaks or is addressed (utils/knowledge.ts).
      const kb = KNOWLEDGE && round && session.room ? await knowledgeFor(session, KNOWLEDGE, before, round.text.split("\n").filter((l) => !l.startsWith("NOTE:")).join("\n")) : null;
      const finale = DATING && session.mode === "game" ? await finaleRound(before, (round?.text ?? userMsg).split("\n").filter((l) => !l.startsWith("NOTE:")).join("\n")) : ""; // the finale pairing is the server's, before the Host speaks
      const rulings: Record<string, import("./utils/ruling.js").Ruling> = {};
      const ruleNote = RULING && session.mode === "game" ? (round ? await ruleRound(before, round.text, rulings) : await (async () => { const r = await rule(before, userMsg); if (r) rulings[USER_ID] = r; return rulingBlock(r); })()) : "";
      let cardNote = "";
      if (DECK && session.mode === "game") { // remember the deck as this turn began, so a replay of it can put the cards back
        session.deck ??= { cards: freshDeck() }; // shuffled once, before the first snapshot, so a replay of turn 1 is dealt from the same deck
        const at = (session.deckAt ??= {});
        at[turn] = structuredClone(session.deck);
        for (const k of Object.keys(at)) if (Number(k) < turn - 50) delete at[Number(k)];
      }
      if (DECK && session.mode === "game" && before.game.phase === DECK.phase) {
        if (DECK.hand > 0) { // a hand per player: the server deals, checks and plays the card the player names
          session.deck = { cards: (session.deck?.cards as Card[] | undefined) ?? freshDeck(), hands: session.deck?.hands as Record<string, Card[]> | undefined };
          const lines = round
            ? round.text.split("\n").flatMap((l) => { const m = /^\[(.+?) \(actors\.([^)]+)\)\]\s*(.*)$/.exec(l); return m && !/^PRIVATE/.test(m[3]!) ? [{ id: m[2]!, name: m[1]!, text: m[3]! }] : []; })
            : [{ id: USER_ID, name: String(before.actors[USER_ID]?.name || "The player"), text: userMsg }];
          cardNote = handsRound(session.deck as { cards: Card[]; hands?: Record<string, Card[]> }, lines, DECK.hand, DECK.note, Math.random, (id, card) => combine(alignmentOf(card, rulings[id] ? RULING?.suits[rulings[id]!.spell] : undefined), classAlignment(card, RULING?.classSuits[String(before.actors[id]?.[RULING.field] ?? "").toLowerCase()])));
        } else {
          const d = drawOne(session.deck?.cards as Card[] | undefined);
          session.deck = { cards: d.deck };
          cardNote = `\n\n## CARD DRAWN (rolled by the server; do not change it)\n${cardName(d.card)}, strength x${multiplier(d.card)}. ${DECK.note}`;
          console.log(`deck: drew ${cardName(d.card)}`);
        }
      }
      const poolNote = NAMING && session.mode === "game" ? poolBlock(await refillPool(session, before)) : "";
      const voiceNote = VOICES && session.mode === "game" ? await voicesBlock(session, before, (round?.text ?? userMsg).split("\n").filter((l) => !l.startsWith("NOTE:") && !/^\[.+? \(actors\.[^)]+\)\]\s*PRIVATE/.test(l)).join("\n")) : "";
      const notes = finale + eventsBlock(session, turn) + cardNote + ruleNote + poolNote + voiceNote + (DATING && session.mode === "game" ? factsBlock(session, before, (round?.text ?? userMsg) + "\n" + String(session.snapshots[turn - 2]?.game.events?.at(-1) ?? "")) : "") + (STATE_NOTES ? stateNotes(session.snapshots[turn - 2], before, catchUp) : catchUp.length ? catchOnly(catchUp) : "") + violations + interfaceContext(req) + (kb?.text ?? "") + turnBlock(session, before, turn) + phaseBlock(before) + worldBlock() + tipNote(before) + nudgeBlock(session) + senseBlock(before) + toneBlock(before) + (GOALS ? goalsBlock(goalStore(session), before, turn) : "") + privateBlock(fold?.latest.length || /PRIVATE/.test(round?.text ?? "") || messages.some((m) => contentText(m.content).includes(PRIVATE_LINE))) + frozenBlock(session, before);
      const base = SYSTEM_PROMPT + stateBlock(before) + recap + (DICE ? diceBlock() : "");
      // Machine guard: a prompt over CONTEXT_MAX_TOKENS is refused before any model is called; nothing is saved.
      if (CONTEXT_MAX_TOKENS > 0) {
        const est = estimateTokens(base.length + notes.length + shown.reduce((n, m) => n + contentText(m.content).length, 0));
        if (est > CONTEXT_MAX_TOKENS) {
          console.warn(`prompt refused (round ${turn}): about ${est} tokens, CONTEXT_MAX_TOKENS is ${CONTEXT_MAX_TOKENS}`);
          sink.refuse(TOO_LONG_REPLY);
          return;
        }
      }
      const wrap = wrapUpStatus(session, turn, base.length + notes.length, shown, before);
      const reveal = GOALS && session.wrapUp !== undefined && turn > session.wrapUp ? takeReveal(session, before) : ""; // after the finale: what everyone secretly wanted (code, once)
      if (wrap.over && WRAP_UP?.over_reply) { // the show is over: answer without calling a model
        sink.canned(reveal ? `${reveal}\n\n${WRAP_UP.over_reply}` : WRAP_UP.over_reply);
        session.snapshots[turn] = before;
        saveSession(key, session);
        return;
      }
      const notAsked = session.mode === "game" && !round ? askedGate(before, USER_ID) : null;
      if (notAsked) { sink.canned(notAsked); session.snapshots[turn] = before; saveSession(key, session); return; }
      if (session.mode === "game" && !round && turn > 1 && userMsg && (await isOffPhase(before, userMsg))) { // the phase lists actions and this fits none: the game's fixed reply, no narrator, nothing changes
        stageSpan(store, "off_phase", Date.now(), { phase: String(before.game.phase ?? "") });
        sink.canned(OFF_PHASE.mode === "ignore" ? "..." : pickOffPhase());
        session.snapshots[turn] = before;
        saveSession(key, session);
        return;
      }
      if ((wrap.final && WRAP_UP?.credits) || reveal) { const c = reqCtx.getStore(); if (c) c.tail = (reveal ? "\n\n" + reveal : "") + (wrap.final && WRAP_UP?.credits ? "\n\n" + WRAP_UP.credits : ""); } // the credits are added after the finale, word for word
      const told = session.mode === "game" ? ownerNotice(session) : null; // the telemetry line and table notices, after the story
      if (told?.text) { const c = reqCtx.getStore(); if (c) c.tail = (c.tail ?? "") + "\n\n" + told.text; }
      if (TERMS && !SEATING && session.mode === "game" && who && real(who) && !session.room) await sendTerms(session, who, Date.now()); // a solo game: the terms come with the first reply
      const mine = typeof who !== "undefined" && who && real(who) && !session.room ? takeFor(session, who.userId) : []; // events meant for this person only: never in a reply at a table (everyone reads it), only in their private chat or a solo chat // events meant for this person only
      if (mine.length) { const c = reqCtx.getStore(); if (c) c.tail = (c.tail ?? "") + "\n\n" + mine.join("\n"); }
      // Notes and wrap-up notices go where the model will weigh them (the tail) when the game asks for it.
      const chat = shown.filter((m) => m.role !== "system");
      body.messages = TAIL_NOTICES
        ? [{ role: "system", content: base }, ...withTail(chat, notes + wrap.text)]
        : [{ role: "system", content: SYSTEM_PROMPT + stateBlock(before) + notes + recap + (DICE ? diceBlock() : "") + wrap.text }, ...chat];

      const justLifted = Object.entries(before.game.rules).filter(([, r]) => !r.active && !r.announced).map(([id]) => id);
      // Early pass: what the player's own message states is recorded while the narrator is still writing.
      let early = null as GameState | null;
      const earlyRun = EARLY_SYNC && userMsg
        ? syncState(before, [{ user: userMsg, narration: "" }], "early").then((st) => {
            early = st;
            session.snapshots[turn] = st; // visible at once (a retry or regenerate of this turn rolls it back)
          }).catch((e) => console.warn("early state sync failed:", (e as Error).message))
        : null;
      traceIO(store, { input: userMsg });
      let narration: string;
      const withTools = toolsOn() ? await narrateWithTools(body, { session, state: before, turn }) : null;
      const kguard = kb && KNOWLEDGE && session.knowledge ? (text: string, messages: unknown[]) => guardNarration(text, { cfg: KNOWLEDGE!, k: session.knowledge!, included: kb.included, turn, messages, body }) : null;
      const priv = session.mode === "game" ? privateNarration(session, before) : null; // a private phase: the table reads a fixed line, the people it is for get the narration
      if (priv) {
        narration = await narrateOnce(body);
        deliverText(sink, priv.line);
        for (const to of priv.to) await announce(session, { kind: "private_narration", to, text: narration });
      } else if (withTools && !withTools.skipped && withTools.text !== null) narration = deliverText(sink, kguard ? await kguard(withTools.text, withTools.messages) : withTools.text); // answered after its tool calls (or without any)
      else {
        if (withTools && !withTools.skipped) body.messages = withTools.messages; // out of rounds: the answer is written now, streamed, with what the tools returned
        if (kb && KNOWLEDGE && holdsReply(KNOWLEDGE, kb.included)) narration = deliverText(sink, await kguard!(await narrateOnce(body), body.messages as unknown[])); // a reply that may hold a secret is checked before the table reads it
        else { narration = await sink.relay(body, "narrator"); if (kguard) await kguard(narration, body.messages as unknown[]); }
      }
      if (kb) markAnnounced(kb.announce);
      traceIO(store, { output: narration });
      if (round && session.room) recordRound(session.room, round.text, narration, turn, !!MULTIPLAYER?.priv?.forget);
      await earlyRun;
      if (promote) key = promote(narration);
      store.session = key;

      // Include any earlier narration that failed to sync, so no change is lost.
      const exchanges = [...session.unsynced, { user: userMsg, narration: store.rawNarration ?? narration }]; // the bookkeeping reads <private> text too; the player never did
      store.rawNarration = undefined;
      let after: GameState = (early as GameState | null) ?? before;
      try {
        after = await syncState(after, exchanges, early as GameState | null ? "recorded" : undefined);
        session.unsynced = [];
      } catch (e) {
        console.warn("state sync failed, will retry next turn:", (e as Error).message);
        session.unsynced = exchanges.slice(-3);
      }
      if (inSetupWindow(turn)) {
        try { after = await analyzeSetup(after, messages, narration, turn); }
        catch (e) { console.warn("setup analysis failed:", (e as Error).message); }
      }
      try { after = await judgeRules(after, { user: userMsg, narration }); }
      catch (e) { console.warn("judge error:", (e as Error).message); }
      const found = await auditRules(after, narration);
      session.violations = found.length ? { turn, items: found } : undefined;
      if (found.length) console.warn(`rule audit: ${found.map((v) => v.id).join(", ")} broken at turn ${turn}`);
      for (const id of justLifted) after.game.rules[id].announced = true; // narrator has now seen it
      if (CREDIT && session.room) {
        const over = anteRound(session); if (over) { session.guesses = {}; session.viewers = {}; await announce(session, { kind: "game_over", text: over }); }
        await creditRound(session, key);
      }
      if (BAN && session.room) { // an actor the narrator flagged as caught is banned; the flag is cleared so it fires once
        for (const p of Object.values(session.room.players)) {
          const a = after.actors[p.actor];
          if (a && a[BAN.flag] === true) { const until = await ban(session, key, p.userId, BAN.hours, "caught looking at another player's cards"); a[BAN.flag] = false; console.log(`ban: ${p.actor} is out until ${new Date(until).toISOString()}`); }
        }
      }
      if (KNOWLEDGE?.overhear && session.room && session.mode === "game") rollTraits(after, KNOWLEDGE); // the fair baseline: dice, once per NPC, never the narrator
      if (KNOWLEDGE && round && session.room && session.knowledge) {
        try {
          const lines = round.text.split("\n").flatMap((l) => { const m = /^\[.+? \(actors\.([^)]+)\)\]\s*(.*)$/.exec(l); return m && !/^(PRIVATE|\(not heard from)/.test(m[2]) ? [{ actor: m[1], text: m[2] }] : []; }); // what people said: not private notes, not fill-ins
          await checkTriggers({ cfg: KNOWLEDGE, session, state: after, lines, narration, turn });
          if (KNOWLEDGE.transfer === "covert") await covertActs({ cfg: KNOWLEDGE, session, state: after, narration, turn });
        } catch (e) { console.warn("knowledge trigger check failed:", (e as Error).message); }
      }
      if (GOALS) after = await goalsRound({ session, before, after, turn, said: (round?.text ?? userMsg).split("\n").filter((l) => !l.startsWith("NOTE:") && !/^\[.+? \(actors\.[^)]+\)\]\s*PRIVATE/.test(l)).join("\n"), narration });
      if (RANDOM_EVENTS.length && session.mode === "game") after = rollEvents(session, after, turn).state; // luck the server rolls: never the narrator
      if (FORFEIT && session.mode === "game") after = rollForfeit(session, after, turn); // a picture owed to the table: dealt and checked by code
      if (HAZARDS && session.mode === "game") after = await rollHazards(session, after, turn); // weather and quakes: dice, season and the producer's modifier, never the narrator
      { const ph0 = String(before?.game?.phase ?? ""); if (ph0 && String(after.game.phase ?? "") !== ph0) after = await runPhaseHook(after, ph0, HAZARDS && after.game.hazard_count !== before?.game?.hazard_count ? "hazard" : "state", undefined, session); } // phase changes carry operations from the imeng's hook
      if (KNOWLEDGE?.debrief && session.mode === "game" && session.room) { const np = String(after.game.phase ?? ""); if (np !== String(before?.game?.phase ?? "") && KNOWLEDGE.debrief.phases.includes(np)) await debrief(session, KNOWLEDGE, turn); } // the producer's beat: what did you gather?
      if (SEATING && session.mode === "game") await seatQueued(session, key, Date.now()); // people who asked for a seat during the hand
      if (TIPS && session.mode === "game") await tipsAfterTurn(session, before, after); // the jar: a cough and a private offer when it is time
      if (AUDIENCE) after = audienceRound(after, round?.text ?? ""); // the crowd's mood, before the dating check uses it
      if (NAMING) after = await nameActors(after);
      if (DATING) { const said = (round?.text ?? userMsg).split("\n").filter((l) => !l.startsWith("NOTE:") && !/^\[.+? \(actors\.[^)]+\)\]\s*PRIVATE/.test(l)).join("\n"); if (turn >= DATING.notesAfter) await ensureNotes(session, after); await revealRound(session, after, `${said}\n${narration}`); }
      if (DATING) after = await datingRound({ session, after, said: (round?.text ?? userMsg).split("\n").filter((l) => !l.startsWith("NOTE:") && !/^\[.+? \(actors\.[^)]+\)\]\s*PRIVATE/.test(l)).join("\n"), narration });
      if (SHOW_CLOCK) after.game.show_minutes = (Number(before.game.show_minutes) || 0) + (SHOW_CLOCK.costs[String(before.game.phase ?? "")] ?? SHOW_CLOCK.perRound) + (await timeJump((round?.text ?? userMsg).split("\n").filter((l) => !l.startsWith("NOTE:")).join("\n"))); // fixed costs, whatever the real clock says
      after = await runGameTurn({ session, before, after, round: turn, said: round?.text ?? userMsg, narration });
      if (typeof after.game.game_turn === "number") store.gameTurn = after.game.game_turn;
      told?.commit();
      if (session.mode === "game") await rehydrateOut(session, after, who);
      session.snapshots[turn] = after;
      if (!round && SYNC.mode !== "off") { session.prints = nextPrints(messages, userMsg, narration); auditLog(session, { turn, kind: "turn", detail: `turn ${turn} recorded` }, SYNC.auditKeep); }
      await maybeCompact(session, messages, narration, after, turn); // never throws
      saveSession(key, session);
    } finally {
      release();
    }
  } catch (e) {
    console.error(e);
    sink.fail(String((e as Error).message || e));
  }
}


/** One request through the engine, with the per-request log context and the MLflow trace (off unless configured). In Redis mode the session's lock is held for the whole turn. */
export function runTurn(inbound: Inbound, sink: Sink): Promise<void> {
  return new Promise<void>((resolve) => {
    void reqCtx.run({ session: "", turn: "", mode: "" }, async () => {
      const t0 = Date.now();
      let failed: string | undefined;
      let lease: Lease | null = null;
      try {
        const chatId = inbound.get("x-openwebui-chat-id");
        lease = await beginSession(chatId ? "chat:" + chatId : null);
        await handleTurn(inbound, sink);
      } catch (e) { failed = String((e as Error).message || e); if (!lease) sink.fail(failed); } // handleTurn answers its own errors; a lock that could not be had is ours to report
      finally {
        await endSession(lease);
        const c = reqCtx.getStore(); if (c) finishTrace(c, t0, failed);
        resolve();
      }
    });
  });
}
