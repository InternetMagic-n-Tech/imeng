import { describe, it, expect } from "@jest/globals";
import { norm, userHash, sketch, similar, transcriptOf, nextPrints, tipOf, agree, planFor, audit, reconcile, REFUSAL } from "../src/utils/sync.js";
import { initialState } from "../src/utils/state.js";
import type { ChatMessage, Session } from "../src/utils/types.js";

const cfg = { mode: "repair" as const, replayTurns: 3, batch: 2, similarity: 0.7, auditKeep: 50 };
const NARR = "The torch flickers as you step into the long stone corridor. Water drips somewhere ahead, and a cold draft carries the smell of old iron and wet earth toward you. Behind you the door settles into its frame with a soft click.";
const chat = (...pairs: [string, string?][]): ChatMessage[] => pairs.flatMap(([u, a]) => [{ role: "user", content: u } as ChatMessage, ...(a === undefined ? [] : [{ role: "assistant", content: a } as ChatMessage])]);
const session = (turns: number, prints?: ReturnType<typeof nextPrints>): Session => ({ snapshots: Array.from({ length: turns + 1 }, (_, i) => { const s = initialState(); s.game.turn = i; return s; }), unsynced: [], mode: "game", prints, tail: Promise.resolve() });
/** A transcript of n completed turns plus a pending message, and the prints a record would have saved for it. */
const world = (n: number) => { const msgs = chat(...Array.from({ length: n }, (_, i) => [`I do thing ${i + 1}`, `${NARR} Turn ${i + 1}.`] as [string, string]), ["pending"]); return { msgs, prints: transcriptOf(msgs).prints }; };

describe("fingerprints", () => {
  it("whitespace and Unicode forms are not a change; a different word is", () => {
    expect(norm("  a\n\n b\t c ")).toBe("a b c");
    expect(userHash("I open the door")).toBe(userHash("  I open   the\ndoor "));
    expect(userHash("I open the door")).not.toBe(userHash("I open the window"));
    expect(userHash("ｆｕｌｌｗｉｄｔｈ")).toBe(userHash("fullwidth"));
  });

  it("sketch: same up to punctuation and spacing; one word changed is close; a rewrite is far; short texts compare exactly", () => {
    expect(sketch(NARR)).toBe(sketch(NARR.replace(/,/g, ";").replace(/\. /g, ".  ")));
    expect(similar(sketch(NARR), sketch(NARR.replace("cold draft", "warm draft")), 0.7)).toBe(true);
    expect(similar(sketch(NARR), sketch("You wake in a bright meadow. Birds sing above the tall grass while a stream runs past a small wooden bridge nearby, and the morning sun is warm on your face."), 0.7)).toBe(false);
    expect(similar(sketch("Yes."), sketch("Yes!"), 0.7)).toBe(true);
    expect(similar(sketch("Yes."), sketch("No."), 0.7)).toBe(false);
    expect(sketch("a b")[0]).toBe("x");
    expect(sketch(NARR)).toMatch(/^[0-9a-f]{72}$/);
  });

  it("transcriptOf: the completed turns only (the pending user message is not one), consecutive users and non-text content", () => {
    const t = transcriptOf([{ role: "system", content: "s" }, ...chat(["one", "A1"], ["two", "A2"], ["pending"])]);
    expect(t.exchanges).toEqual([{ user: "one", narration: "A1" }, { user: "two", narration: "A2" }]);
    expect(t.prints).toHaveLength(2);
    expect(transcriptOf(chat(["one"], ["two", "A2"], ["pending"])).exchanges[0]).toEqual({ user: "one", narration: "" }); // no reply to the first
    expect(transcriptOf([{ role: "user", content: [{ type: "text", text: "hi" }] } as ChatMessage, { role: "assistant", content: "yo" }]).exchanges).toEqual([{ user: "hi", narration: "yo" }]);
    expect(transcriptOf([]).prints).toEqual([]);
  });

  it("nextPrints adds the turn just answered to the completed turns; tipOf is stable and changes with the prints", () => {
    const { msgs, prints } = world(2);
    const p = nextPrints(msgs, "pending", "The answer.");
    expect(p).toHaveLength(3);
    expect(p.slice(0, 2)).toEqual(prints);
    expect(tipOf(p)).toBe(tipOf([...p]));
    expect(tipOf(p)).not.toBe(tipOf(prints));
    expect(tipOf(undefined)).toBe(tipOf([]));
  });
});

describe("planFor", () => {
  it("ok when they agree; nothing to verify for a new empty chat", () => {
    const { prints } = world(3);
    expect(planFor(session(3, prints), { prints }, true, 0.7)).toEqual({ kind: "ok" });
    expect(planFor(session(0), { prints: [] }, false, 0.7)).toEqual({ kind: "ok" });
  });

  it("back: the player regenerated or edited the latest message (fewer completed turns, same history)", () => {
    const { prints } = world(3);
    expect(planFor(session(3, prints), { prints: prints.slice(0, 2) }, true, 0.7)).toEqual({ kind: "back", from: 3, to: 2 });
  });

  it("diverged: an earlier user message was edited, or a reply was changed materially (and a tiny change is not a change)", () => {
    const a = world(3), b = chat(["I do thing 1", `${NARR} Turn 1.`], ["I do something else", `${NARR} Turn 2.`], ["I do thing 3", `${NARR} Turn 3.`], ["pending"]);
    expect(planFor(session(3, a.prints), transcriptOf(b), true, 0.7)).toEqual({ kind: "diverged", at: 2, why: "edited" });
    const rewritten = chat(["I do thing 1", `${NARR} Turn 1.`], ["I do thing 2", "A completely different paragraph about a harbour at dawn, with gulls, rope, tar and a long grey swell rolling in from the east."], ["I do thing 3", `${NARR} Turn 3.`], ["pending"]);
    expect(planFor(session(3, a.prints), transcriptOf(rewritten), true, 0.7)).toEqual({ kind: "diverged", at: 2, why: "edited" });
    const tiny = chat(["I do thing 1", `${NARR} Turn 1.`], ["I do thing 2", `${NARR.replace("cold draft", "warm draft")} Turn 2.`], ["I do thing 3", `${NARR} Turn 3.`], ["pending"]);
    expect(planFor(session(3, a.prints), transcriptOf(tiny), true, 0.7)).toEqual({ kind: "ok" });
    expect(agree(a.prints, transcriptOf(b).prints, 0.7)).toBe(1);
  });

  it("behind: the transcript has turns the record never saw", () => {
    const { prints } = world(4);
    expect(planFor(session(2, prints.slice(0, 2)), { prints }, true, 0.7)).toEqual({ kind: "diverged", at: 3, why: "behind" });
  });

  it("rebuild when there is a conversation and no record; adopt when a record has no fingerprints yet (from before this feature)", () => {
    const { prints } = world(3);
    expect(planFor(session(0), { prints }, false, 0.7)).toEqual({ kind: "rebuild" });
    expect(planFor(session(3), { prints }, true, 0.7)).toEqual({ kind: "adopt" });
    expect(planFor(session(0), { prints }, true, 0.7)).toEqual({ kind: "ok" }); // a record with no turns and no fingerprints: nothing to adopt
  });
});

describe("audit", () => {
  it("is bounded, keeps no message text, and carries the fingerprint tip", () => {
    const s = session(1, world(1).prints);
    for (let i = 0; i < 80; i++) audit(s, { turn: i, kind: "turn", detail: `turn ${i} recorded` }, 50, 1000 + i);
    expect(s.audit).toHaveLength(50);
    expect(s.audit![0].turn).toBe(30);
    expect(s.audit![0]).toMatchObject({ at: 1030, kind: "turn", tip: tipOf(s.prints) });
    audit(s, { turn: 1, kind: "back", detail: "x".repeat(1000) }, 50);
    expect(s.audit!.at(-1)!.detail).toHaveLength(240);
  });
});

describe("reconcile", () => {
  const ok = (calls: any[]) => async (st: any, ex: any[]) => { calls.push(ex.map((e) => e.user)); const n = structuredClone(st); n.game.replayed = (n.game.replayed ?? 0) + ex.length; return n; };

  it("off: nothing is done", async () => {
    const s = session(0), r = await reconcile({ session: s, messages: world(3).msgs, created: true, turn: 4, syncFn: ok([]), cfg: { ...cfg, mode: "off" } });
    expect(r).toEqual({ notes: [], rebuilt: false });
    expect(s.audit).toBeUndefined();
  });

  it("detect: a difference is logged and nothing is repaired (the old behaviour stands)", async () => {
    const a = world(3), s = session(3, a.prints), calls: any[] = [];
    const edited = chat(["I do thing 1", `${NARR} Turn 1.`], ["CHANGED", `${NARR} Turn 2.`], ["I do thing 3", `${NARR} Turn 3.`], ["pending"]);
    const r = await reconcile({ session: s, messages: edited, created: false, turn: 4, syncFn: ok(calls), cfg: { ...cfg, mode: "detect" } });
    expect(r.notes).toEqual([]);
    expect(calls).toEqual([]);
    expect(s.snapshots).toHaveLength(4);
    expect(s.audit!.at(-1)).toMatchObject({ kind: "detected" });
    expect(s.audit!.at(-1)!.detail).toContain("nothing was repaired");
  });

  it("repair, an earlier message edited: rolls back to before it and replays the turns from there in batches", async () => {
    const a = world(5), s = session(5, a.prints), calls: any[] = [];
    s.snapshots.forEach((x, i) => { x.game.mark = `before-${i}`; });
    const edited = chat(["I do thing 1", `${NARR} Turn 1.`], ["I do thing 2", `${NARR} Turn 2.`], ["EDITED", `${NARR} Turn 3.`], ["I do thing 4", `${NARR} Turn 4.`], ["I do thing 5", `${NARR} Turn 5.`], ["pending"]);
    const r = await reconcile({ session: s, messages: edited, created: false, turn: 6, syncFn: ok(calls), cfg });
    expect(calls).toEqual([["EDITED", "I do thing 4"], ["I do thing 5"]]); // turns 3..5, two at a time
    expect(s.snapshots).toHaveLength(6); // states after 0..5 completed turns
    expect(s.snapshots[2].game.mark).toBe("before-2"); // untouched: before the edit
    expect(s.snapshots[3].game.replayed).toBe(2); expect(s.snapshots[4].game.replayed).toBe(2); expect(s.snapshots[5].game.replayed).toBe(3);
    expect(s.snapshots[5].game.turn).toBe(5);
    expect(s.prints).toEqual(transcriptOf(edited).prints);
    expect(r.notes[0]).toContain("corrected to match the conversation");
    expect(s.audit!.at(-1)).toMatchObject({ kind: "replay" });
    expect(s.audit!.at(-1)!.detail).toContain("turn 3 of the conversation is not what the record was built from");
    expect(s.approximate).toBeUndefined(); // everything was replayed
  });

  it("repair, a record that is gone: rebuilt from the last replay_turns, the earlier ones skipped and flagged approximate", async () => {
    const { msgs } = world(6), s = session(0), calls: any[] = [];
    delete s.prints; s.snapshots.length = 1;
    const r = await reconcile({ session: s, messages: msgs, created: true, turn: 7, syncFn: ok(calls), cfg });
    expect(calls).toEqual([["I do thing 4", "I do thing 5"], ["I do thing 6"]]); // replay_turns 3
    expect(s.snapshots).toHaveLength(7);
    expect(s.snapshots[3].game.replayed).toBeUndefined(); // turns 1-3 keep the starting state
    expect(s.snapshots[6].game.replayed).toBe(3);
    expect(s.approximate).toBe(true);
    expect(r.rebuilt).toBe(true);
    expect(r.notes[0]).toContain("rebuilt from the conversation (3 recent turn(s) replayed, 3 earlier not)");
    expect(s.audit!.at(-1)).toMatchObject({ kind: "rebuild" });
  });

  it("repair, turns the record never saw: replays just those", async () => {
    const a = world(4), s = session(2, a.prints.slice(0, 2)), calls: any[] = [];
    await reconcile({ session: s, messages: a.msgs, created: false, turn: 5, syncFn: ok(calls), cfg });
    expect(calls).toEqual([["I do thing 3", "I do thing 4"]]);
    expect(s.snapshots).toHaveLength(5);
    expect(s.audit!.at(-1)!.detail).toContain("2 turn(s) the record never saw");
  });

  it("back and adopt need no model: the engine rolls back as before; an old record is trusted", async () => {
    const a = world(3), calls: any[] = [];
    const s = session(3, a.prints);
    await reconcile({ session: s, messages: [...a.msgs.slice(0, 2), { role: "user", content: "pending" } as ChatMessage], created: false, turn: 2, syncFn: ok(calls), cfg });
    expect(s.prints).toHaveLength(1);
    expect(s.audit!.at(-1)).toMatchObject({ kind: "back" });
    expect(s.audit!.at(-1)!.detail).toContain("from turn 3 to 1");
    const old = session(3); // no prints
    await reconcile({ session: old, messages: a.msgs, created: false, turn: 4, syncFn: ok(calls), cfg });
    expect(old.prints).toHaveLength(3);
    expect(old.audit!.at(-1)).toMatchObject({ kind: "adopt" });
    expect(calls).toEqual([]);
  });

  it("an extractor that fails: the unreplayed turns wait in unsynced, the record is flagged, and nothing throws", async () => {
    const a = world(4), s = session(0), down = async () => { throw new Error("fetch failed"); };
    delete s.prints; s.snapshots.length = 1;
    const r = await reconcile({ session: s, messages: a.msgs, created: true, turn: 5, syncFn: down, cfg });
    expect(r.refuse).toBeUndefined();
    expect(s.unsynced.map((e) => e.user)).toEqual(["I do thing 2", "I do thing 3", "I do thing 4"]);
    expect(s.snapshots).toHaveLength(5);
    expect(s.syncFailures).toBe(1);
    expect(s.approximate).toBe(true);
    expect(r.notes.join(" ")).toContain("behind the story");
    expect(s.audit!.map((x) => x.kind)).toContain("replay-failed");
  });

  it("after three failed attempts in a row it refuses with a clear message; when the extractor is back it recovers", async () => {
    const a = world(3), down = async () => { throw new Error("fetch failed"); };
    const s = session(0); delete s.prints; s.snapshots.length = 1;
    let r = await reconcile({ session: s, messages: a.msgs, created: true, turn: 4, syncFn: down, cfg });
    expect(r.refuse).toBeUndefined();
    for (let i = 0; i < 2; i++) { // the player tries again: the transcript still has turns the record has not absorbed? the prints now match, so replay is via unsynced; force a second divergence
      s.prints = s.prints!.slice(0, 1);
      r = await reconcile({ session: s, messages: a.msgs, created: false, turn: 4, syncFn: down, cfg });
    }
    expect(r.refuse).toBe(REFUSAL);
    expect(s.abandoned).toMatchObject({ reason: "the record could not be rebuilt" });
    expect(s.audit!.map((x) => x.kind)).toContain("refused");
    s.prints = s.prints!.slice(0, 1);
    r = await reconcile({ session: s, messages: a.msgs, created: false, turn: 4, syncFn: ok([]), cfg });
    expect(r.refuse).toBeUndefined();
    expect(s.abandoned).toBeUndefined();
    expect(s.syncFailures).toBe(0);
    r = await reconcile({ session: s, messages: a.msgs, created: false, turn: 4, syncFn: ok([]), cfg }); // in step again
    expect(r).toEqual({ notes: [], rebuilt: false });
  });

  it("a batch that fails half way keeps what was replayed and does not count as a total failure", async () => {
    const a = world(4), s = session(0); delete s.prints; s.snapshots.length = 1;
    let n = 0;
    const flaky = async (st: any, ex: any[]) => { if (++n === 2) throw new Error("boom"); const c = structuredClone(st); c.game.replayed = (c.game.replayed ?? 0) + ex.length; return c; };
    const r = await reconcile({ session: s, messages: a.msgs, created: true, turn: 5, syncFn: flaky, cfg: { ...cfg, replayTurns: 4 } });
    expect(s.snapshots[2].game.replayed).toBe(2);
    expect(s.snapshots[4].game.replayed).toBe(2); // the last good state fills the rest
    expect(s.unsynced.map((e) => e.user)).toEqual(["I do thing 3", "I do thing 4"]);
    expect(s.syncFailures).toBe(0);
    expect(r.refuse).toBeUndefined();
  });
});
