import { jsonResponse, mockFetch, sseChunks, sseResponse } from "./helpers.js";

export interface OllamaCall { kind: "narrator" | "extractor" | "invocation" | "rule_judge" | "setup" | "compactor" | "compaction_judge" | "rule_audit" | "rule_confirm" | "compaction_extract" | "room_message" | "room_join" | "knowledge_fact" | "knowledge_trigger" | "knowledge_match" | "knowledge_covert" | "game_turn" | "unload" | "image_prompt" | "image_offer" | "goal_read" | "goal_mark" | "goal_invent" | "image_refine" | "keepsake_options" | "case_judge" | "repair" | "gate" | "dating" | "dating_notes" | "dating_reveal" | "pii_newclass" | "show_clock" | "naming" | "voice" | "ruling" | "tone"; body: any }

/** A scripted stand-in for Ollama (narrator, extractor and the judge), installed as global fetch. */
export function makeOllama() {
  const s = {
    narration: "The torch flickers.",
    narratorThrows: false,
    extractor: [] as unknown[],          // queue: ops arrays, or raw strings; empty => {"ops":[]}
    invoke: { invoked: true, reason: "asks to play" } as unknown,
    verdicts: [] as unknown[],           // queue of verdict arrays for the rule judge
    setup: { rules: [], actors: [] } as unknown,
    recap: [] as string[],               // queue of recaps the compactor writes
    recapVerdicts: [] as unknown[],      // queue of verdicts from the compaction judge
    extracts: [] as unknown[],           // queue of recap-reading answers ({people: [...]})
    confirms: [] as unknown[],           // queue of confirmation answers (default: confirmed)
    audits: [] as unknown[],             // queue of audit results ({violations: [...]})
    roomMessages: [] as unknown[],       // queue of readings of a shared-game message (default: {kind: "act"})
    joins: [] as unknown[],              // queue of answers to "does this message ask to join?" (default: {join: true})
    facts: [] as unknown[],              // queue of readings of a private message as a secret (default: {kind: "note"})
    triggers: [] as unknown[],           // queue of discovery checks (default: nothing fired)
    matches: [] as unknown[],
    turnVerdicts: [] as unknown[],       // queue of game-turn judge answers ({advanced, released}); default: not advanced
    imagePrompts: [] as unknown[],       // queue of image-prompt answers ({prompt, actor}); default: a plain prompt
    offers: [] as unknown[],             // queue of picture-request readings ({wants, subject}); default: not a request
    goalReads: [] as unknown[],          // queue of private-note readings ({goal}); default: not a goal
    goalMarks: [] as unknown[],          // queue of "which goals were reached" answers ({reached: [{id, quote}]}); default: none
    refines: [] as unknown[],            // queue of refined image prompts ({prompt, avoid}); default: the prompt unchanged
    caseJudges: [] as unknown[],         // queue of case-judge answers ({ok, why}); default: ok
    keepsakeOptions: [] as unknown[],    // queue of keepsake proposals ({options}); default: two plain options
    goalInvents: [] as unknown[],        // queue of invented NPC goals ({goal}); default: a plain goal
    covert: [] as unknown[],             // queue of covert-act lists (default: none)            // queue of "who speaks" readings (default: nobody)
    narrations: [] as string[],          // queue of narrations used before `narration` (retries)
    rulings: [] as unknown[],            // queue of magic-ruling answers ({spell, allowed, reason}); default: not a magic attempt
    voices: {} as Record<string, string>, // what each character says, by the NAME line of its persona prompt; default: "<Name> nods."
    tones: [] as number[], // what the tone judge rates the next person; default 0.8
    names: ["Priya", "Marcus", "Lena", "Omar", "Sadie", "Felix"] as string[], // names the naming call hands out, in order
    jumps: [] as unknown[],              // queue of time-jump answers ({minutes}); default: 0
    newClass: [] as unknown[],           // queue of new-class judge answers ({mentions}); default: none
    datingNotes: [] as unknown[],        // queue of private-note answers ({notes}); default: a like, a passion, an outfit
    datingReveals: [] as unknown[],      // queue of reveal answers ({reveals}); default: none
    dating: [] as unknown[],             // queue of dating-judge answers ({evidence}); default: none
    gates: [] as unknown[],              // queue of off-phase gate answers ({action}); default: the first listed action
    repairs: [] as unknown[],            // queue of repair-judge answers ({ops}); default: no correction
    judgeDown: false,
    extractorDown: false,                // the extractor call fails (the connection is refused)
    toolCalls: [] as unknown[],          // queue of narrator messages to answer a call that offers tools (e.g. {content: "", tool_calls: [{id, type: "function", function: {name, arguments}}]}); empty: a normal answer
    calls: [] as OllamaCall[],
  };
  const fetchMock = mockFetch((url, body) => {
    if (url.endsWith("/api/generate")) { s.calls.push({ kind: "unload", body }); return jsonResponse({ done: true }); }
    if (url.endsWith("/api/chat")) {
      const sys: string = body.messages[0].content;
      const reply = (kind: OllamaCall["kind"], payload: unknown) => {
        s.calls.push({ kind, body });
        return jsonResponse({ message: { content: JSON.stringify(payload) } });
      };
      if (s.judgeDown) throw new TypeError("fetch failed");
      if (sys.includes("You verify one accusation")) return reply("rule_confirm", s.confirms.shift() ?? { confirmed: true, rule_forbids_it: true, their_rule: "Nobody is asked to jump." });
      if (sys.includes("You read one message in a shared game")) return reply("room_message", s.roomMessages.shift() ?? { kind: "act" });
      if (sys.includes("You list the secret dealings")) return reply("knowledge_covert", s.covert.shift() ?? { covert: [] });
      if (sys.includes("You turn one private message")) return reply("knowledge_fact", s.facts.shift() ?? { kind: "note" });
      if (sys.includes("You watch a shared game for the moment")) return reply("knowledge_trigger", s.triggers.shift() ?? { fired: [], confirmed: [] });
      if (sys.includes("You read one round of a shared game")) return reply("knowledge_match", s.matches.shift() ?? { speaking: [] });
      if (sys.includes("You decide whether a game") && sys.includes("has just completed")) return reply("game_turn", s.turnVerdicts.shift() ?? { advanced: false });
      if (sys.includes("You read one private note a player wrote")) return reply("goal_read", s.goalReads.shift() ?? { goal: "" });
      if (sys.includes("You decide which secret goals were reached")) return reply("goal_mark", s.goalMarks.shift() ?? { reached: [] });
      if (sys.includes("You invent one secret goal")) return reply("goal_invent", s.goalInvents.shift() ?? { goal: "get everyone to laugh" });
      if (sys.includes("You rewrite one image prompt")) { const raw = String(body.messages[1].content).replace(/^PROMPT: /, ""); return reply("image_refine", s.refines.shift() ?? { prompt: raw, avoid: "" }); }
      if (sys.includes("what a player's message is doing")) return reply("gate", s.gates.shift() ?? { action: /^- (\w+):/m.exec(String(body.messages[1].content))?.[1] ?? "none" });
      if (sys.includes("You rule on a magic attempt")) return reply("ruling", s.rulings.shift() ?? { spell: "", allowed: true, reason: "" });
      if (sys.includes("You are one character in a text game")) { const nm = /NAME: (.+)/.exec(String(body.messages?.at(-1)?.content ?? ""))?.[1]?.trim() ?? "?"; return reply("voice", { line: s.voices[nm] ?? `${nm} nods.` }); }
      if (sys.includes("You rate how one person behaves in a group chat")) return reply("tone", { tone: s.tones.shift() ?? 0.8 });
      if (sys.includes("Choose a first name")) return reply("naming", { name: s.names.shift() ?? "Wren" });
      if (sys.includes("You read one round of a TV show game")) return reply("show_clock", s.jumps.shift() ?? { minutes: 0 });
      if (sys.includes("You look for private details in a message that a normal")) return reply("pii_newclass", s.newClass.shift() ?? { mentions: [] });
      if (sys.includes("You write the private notes of one contestant")) return reply("dating_notes", s.datingNotes.shift() ?? { notes: [{ kind: "like", text: "cats" }, { kind: "passion", text: "skydiving" }, { kind: "outfit", text: "a straw hat and a red swimsuit underneath" }] });
      if (sys.includes("You decide which hidden facts about contestants")) return reply("dating_reveal", s.datingReveals.shift() ?? { reveals: [] });
      if (sys.includes("You judge whether anyone in a TV show warmed") || sys.includes("You read a TV show finale")) return reply("dating", s.dating.shift() ?? { evidence: [] });
      if (sys.includes("You fix bookkeeping changes")) return reply("repair", s.repairs.shift() ?? { ops: [] });
      if (sys.includes("You check one claim about a play-through")) return reply("case_judge", s.caseJudges.shift() ?? { ok: true, why: "fine" });
      if (sys.includes("You propose keepsakes")) return reply("keepsake_options", s.keepsakeOptions.shift() ?? { options: ["a small trophy for {name}", "a social media thumbnail of {name}, the real winner of {game}"] });
      if (sys.includes("You write one image prompt")) return reply("image_prompt", s.imagePrompts.shift() ?? { prompt: "a dim corridor", actor: null });
      if (sys.includes("You decide whether a player's message asks for a picture")) return reply("image_offer", s.offers.shift() ?? { wants: false, subject: "" });
      if (sys.includes("You decide whether a message asks to join")) return reply("room_join", s.joins.shift() ?? { join: true });
      if (sys.includes("You audit one reply")) return reply("rule_audit", s.audits.shift() ?? { violations: [] });
      if (sys.includes("You check a recap")) return reply("compaction_judge", s.recapVerdicts.shift() ?? { faithful: true, invented: [], missing: [] });
      if (sys.includes("invokes these instructions")) return reply("invocation", s.invoke);
      if (sys.includes("review standing rules")) return reply("rule_judge", { verdicts: s.verdicts.shift() ?? [] });
      if (sys.includes("You read the opening messages")) return reply("setup", s.setup);
      throw new Error("unknown judge prompt: " + sys.slice(0, 40));
    }
    if (url.endsWith("/chat/completions")) {
      if (body.response_format && String(body.messages?.[0]?.content).includes("You read a recap of a game")) {
        s.calls.push({ kind: "compaction_extract", body });
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(s.extracts.shift() ?? { people: [] }) } }] });
      }
      if (body.response_format && String(body.messages?.[0]?.content).includes("You verify one accusation")) {
        s.calls.push({ kind: "rule_confirm", body });
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(s.confirms.shift() ?? { confirmed: true, rule_forbids_it: true, their_rule: "Nobody is asked to jump." }) } }] });
      }
      if (body.response_format && String(body.messages?.[0]?.content).includes("You audit one reply")) {
        s.calls.push({ kind: "rule_audit", body });
        if (s.judgeDown) throw new TypeError("fetch failed");
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(s.audits.shift() ?? { violations: [] }) } }] });
      }
      if (body.response_format && String(body.messages?.[0]?.content).includes("You list the secret dealings")) {
        s.calls.push({ kind: "knowledge_covert", body });
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(s.covert.shift() ?? { covert: [] }) } }] });
      }
      if (body.response_format) {
        s.calls.push({ kind: "extractor", body });
        if (s.extractorDown) throw new TypeError("fetch failed");
        const next = s.extractor.shift();
        const content = typeof next === "string" ? next : JSON.stringify({ ops: next ?? [] });
        return jsonResponse({ choices: [{ message: { content } }] });
      }
      if (String(body.messages?.[0]?.content).includes("You write a recap")) {
        s.calls.push({ kind: "compactor", body });
        return jsonResponse({ choices: [{ message: { content: s.recap.shift() ?? "" } }] });
      }
      s.calls.push({ kind: "narrator", body });
      if (s.narratorThrows) throw new TypeError("fetch failed");
      const said = s.narrations.shift() ?? s.narration;
      if (body.tools && s.toolCalls.length) return jsonResponse({ choices: [{ message: s.toolCalls.shift() }] });
      return body.stream
        ? sseResponse(sseChunks(said))
        : jsonResponse({ choices: [{ message: { content: said, reasoning: "thinking" } }] });
    }
    throw new Error("unexpected url " + url);
  });
  return {
    s,
    fetchMock,
    calls: (kind: OllamaCall["kind"]) => s.calls.filter((c) => c.kind === kind),
    reset() { s.calls.length = 0; s.extractor.length = 0; s.verdicts.length = 0; s.recap.length = 0; s.recapVerdicts.length = 0; s.audits.length = 0; s.toolCalls.length = 0; s.roomMessages.length = 0; s.joins.length = 0; s.confirms.length = 0; s.facts.length = 0; s.triggers.length = 0; s.matches.length = 0; s.covert.length = 0; s.turnVerdicts.length = 0; s.imagePrompts.length = 0; s.offers.length = 0; s.goalReads.length = 0; s.goalMarks.length = 0; s.goalInvents.length = 0; s.refines.length = 0; s.keepsakeOptions.length = 0; s.caseJudges.length = 0; s.repairs.length = 0; s.gates.length = 0; s.dating.length = 0; s.datingNotes.length = 0; s.newClass.length = 0; s.jumps.length = 0; s.voices = {}; s.tones.length = 0; s.rulings.length = 0; s.datingReveals.length = 0; s.narrations.length = 0; s.extracts.length = 0; s.judgeDown = false; s.narratorThrows = false; },
  };
}
