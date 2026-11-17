import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/multiplayer"); // multiplayer on
process.env.MULTIPLAYER_DEBUG = "1";

const mp = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");
const { initialState } = await import("../src/utils/state.js");
type Cfg = NonNullable<typeof MULTIPLAYER>;
type Ctx = Exclude<Parameters<typeof mp.step>[4], number>;

const cfg = (over: Partial<Cfg> = {}): Cfg => ({ ...MULTIPLAYER!, ...over });
const alice = { userId: "u-alice", name: "Alice" }, pat = { userId: "u-pat", name: "Pat" }, cy = { userId: "u-cy", name: "Cy" };
const say = (room: ReturnType<typeof mp.newRoom>, p: { userId: string; name: string }, text: string, c: Cfg = cfg(), ctx: number | Ctx = 1000) => mp.step(room, p, text, c, ctx)!;
const at = (now: number, over: Partial<Ctx> = {}): Ctx => ({ now, ...over });
/** A room with two people at the table (Alice and Pat). */
const duo = (c: Cfg = cfg()) => { const r = mp.newRoom(); mp.join(r, alice, c, 0); mp.join(r, pat, c, 0); return r; };
const text = (s: ReturnType<typeof mp.step>) => (s && "text" in s ? s.text : "");
const DAY = 86_400_000;

beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { fs.rmSync(path.join(process.env.SAVE_DIR!, "multiplayer-debug.jsonl"), { force: true }); });

describe("config", () => {
  it("is on only when enabled, with defaults", () => {
    expect(MULTIPLAYER).toMatchObject({ turns: "ready", offTurn: "note", order: "fifo", standing: "private", defaultAction: "says nothing", judge: true, resetOnTalk: true, minPlayers: 2, idleMs: 0, maxPlayers: 8, defaultAfter: null });
    expect(MULTIPLAYER!.tension).toEqual({ mode: "status", maxWords: 25, cooldownMs: 0 });
    expect(MULTIPLAYER!.priv).toEqual({ reply: "ack", narratorSees: true, maxWords: 60, unseated: "ignore", forget: false });
    expect(MULTIPLAYER!.seatMs).toBe(14 * DAY);
    expect(MULTIPLAYER!.clock).toEqual({ field: "game.minutes", unit: "minute" });
    expect(MULTIPLAYER!.confirm.test("Ready!")).toBe(true);
    expect(MULTIPLAYER!.confirm.test("I am ready to fight")).toBe(false);
    for (const t of ["leave the table", "Quit game.", "  leave game"]) expect(MULTIPLAYER!.leave.test(t)).toBe(true);
    expect(MULTIPLAYER!.leave.test("I will leave the table in a minute")).toBe(false);
  });
});

describe("who is asking", () => {
  it("playerOf reads Open WebUI's user headers, decodes the URL-encoded name, and has fallbacks", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(mp.playerOf(h({ "x-openwebui-user-id": "u1", "x-openwebui-user-name": "Bea" }))).toEqual({ userId: "u1", name: "Bea" });
    expect(mp.playerOf(h({ "x-openwebui-user-id": "u1", "x-openwebui-user-name": "Zo%C3%AB%20Ng" }))).toEqual({ userId: "u1", name: "Zoë Ng" });
    expect(mp.playerOf(h({ "x-openwebui-user-id": "u1", "x-openwebui-user-name": "100%" })).name).toBe("100%"); // not valid encoding: kept as is
    expect(mp.playerOf(() => undefined)).toEqual({ userId: "anonymous", name: "Player" });
    expect(mp.playerOf(h({ "x-openwebui-user-id": "12345678-aaaa" })).name).toBe("12345678");
  });
});

describe("players", () => {
  it("the first player is actors.user; the others get an actor from their name, never a clash", () => {
    const r = mp.newRoom();
    expect(mp.join(r, alice, cfg(), 0)!.actor).toBe("user");
    expect(mp.join(r, pat, cfg(), 0)!.actor).toBe("p_pat");
    expect(mp.join(r, { userId: "u-pat2", name: "Pat" }, cfg(), 0)!.actor).toBe("p_pat_2");
    expect(mp.join(r, { userId: "u-sym", name: "!!!" }, cfg(), 0)!.actor).toBe("p_player");
    expect(mp.join(r, alice, cfg(), 5)!.lastSeen).toBe(5);
    expect(r.order).toHaveLength(4);
  });

  it("a full table refuses a newcomer", () => {
    const c = cfg({ maxPlayers: 2 });
    const r = mp.newRoom();
    mp.join(r, alice, c, 0); mp.join(r, pat, c, 0);
    expect(mp.join(r, cy, c, 0)).toBeNull();
    expect(mp.step(r, cy, "hi", c, 0)).toBeNull();
  });

  it("syncPlayers gives every player an actor, never an NPC, and a name", () => {
    const r = duo();
    const s = initialState();
    mp.syncPlayers(s, r, { name: "", hp: null, statuses: [] });
    expect(s.actors.user).toMatchObject({ name: "Alice", controlled_by: "user" });
    expect(s.actors.p_pat).toMatchObject({ name: "Pat", controlled_by: "other_player", hp: null, statuses: [] });
    s.actors.p_pat.controlled_by = "npc";
    mp.syncPlayers(s, r, {});
    expect(s.actors.p_pat.controlled_by).toBe("other_player");
  });
});

describe("policy ready (the default)", () => {
  it("one person at the table: no gate, every message is a round", () => {
    expect(text(say(mp.newRoom(), alice, "I look around"))).toBe("[Alice (actors.user)] I look around");
  });

  it("talk is collected, the round starts when all are ready, every line attributed", () => {
    const r = duo();
    expect(say(r, alice, "I take the key")).toMatchObject({ kind: "reply" });
    expect(text(say(r, pat, "I hold the door"))).toContain("Waiting for: Alice, Pat");
    expect(text(say(r, alice, "ready"))).toBe("Ready: Alice. Waiting for: Pat.");
    const s = say(r, pat, "READY!");
    expect(s.kind).toBe("round");
    if (s.kind === "round") {
      expect(s.text).toBe("[Alice (actors.user)] I take the key\n[Pat (actors.p_pat)] I hold the door");
      expect(s.messages.at(-1)).toEqual({ role: "user", content: s.text });
      expect(s.players.map((p) => p.name)).toEqual(["Alice", "Pat"]);
    }
    expect(r.talk).toEqual([]); expect(r.confirmed).toEqual([]);
  });

  it("a silenced player (the dead) is not waited on: the others' ready starts the round", () => {
    const r = duo();
    const dead = { silenced: (actor: string) => actor === "p_pat" };
    expect(text(mp.step(r, alice, "I press on", cfg(), { now: 0, ...dead }) as any)).toContain("Waiting for: Alice");
    const out = mp.step(r, alice, "ready", cfg(), { now: 0, ...dead });
    expect(out?.kind).toBe("round"); // Pat is dead: only Alice's ready is needed
  });

  it("everybody ready with nothing said: the round still happens", () => {
    const r = duo();
    say(r, alice, "ready");
    expect(text(say(r, pat, "go"))).toBe("[Alice (actors.user)] (ready; says nothing)\n[Pat (actors.p_pat)] (ready; says nothing)");
  });

  it("a mention before the words is not part of them (the game's own name, or anyone's)", () => {
    const r = duo();
    say(r, alice, "@mp-game  I sneak");
    say(r, pat, "@someone @mp-game ready");
    expect(text(say(r, alice, "@MP-GAME ready"))).toBe("[Alice (actors.user)] I sneak");
  });

  it("saying something new takes the ready back (unless reset_on_talk is off); a repeated ready counts once", () => {
    const r = duo();
    say(r, alice, "ready"); say(r, alice, "ready");
    expect(r.confirmed).toEqual(["u-alice"]);
    say(r, alice, "wait, I also shout");
    expect(r.confirmed).toEqual([]);
    const keep = duo();
    say(keep, alice, "ready", cfg({ resetOnTalk: false })); say(keep, alice, "and more", cfg({ resetOnTalk: false }));
    expect(keep.confirmed).toEqual(["u-alice"]);
  });

  it("idle players are not waited for (idle_minutes)", () => {
    const r = duo();
    const c = cfg({ idleMs: 60_000 });
    say(r, alice, "I go on alone", c, 1_000_000);
    const s = say(r, alice, "ready", c, 1_000_000);
    expect(s.kind === "round" && s.players.map((p) => p.name)).toEqual(["Alice"]);
  });

  it("a custom confirm pattern", () => {
    const r = duo();
    const c = cfg({ confirm: /^(oui|d'accord)$/i });
    say(r, alice, "oui", c); say(r, pat, "ready", c);
    expect(r.confirmed).toEqual(["u-alice"]);
    expect(r.talk).toEqual([{ userId: "u-pat", text: "ready" }]);
  });
});

describe("what the table is holding its breath on (for a tension beat)", () => {
  it("a waiting reply says who is awaited, what each person declared so far, who just spoke, and the scene", () => {
    const r = duo();
    mp.recordRound(r, "[...]", "The villain sneers across the rooftop. Wolverine's claws are out.", 1);
    say(r, alice, "Wolverine leaps at the villain");
    const s = say(r, pat, "I shout a warning");
    expect(s.kind === "reply" && s.hold).toEqual({
      waiting: ["Alice", "Pat"],
      declared: [{ who: "Alice", text: "Wolverine leaps at the villain" }, { who: "Pat", text: "I shout a warning" }],
      spoke: { who: "Pat", text: "I shout a warning" },
      scene: "The villain sneers across the rooftop. Wolverine's claws are out.",
    });
    const t = say(r, pat, "ready");
    expect(t.kind === "reply" && t.hold!.spoke).toBeUndefined(); // a confirmation is not something said
    expect(t.kind === "reply" && t.hold!.waiting).toEqual(["Alice"]);
  });

  it("token and judged waits carry a hold too", () => {
    const c = cfg({ turns: "token" });
    const r = duo(c);
    const s = say(r, pat, "hurry!", c, at(1, { token: "user" }));
    expect(s.kind === "reply" && s.hold).toMatchObject({ waiting: ["Alice"], spoke: { who: "Pat", text: "hurry!" } });
    const j = cfg({ turns: "judged" });
    const q = duo(j);
    const h = say(q, pat, "any news?", j, at(1, { verdict: { kind: "chat", awaiting: ["Alice"] } }));
    expect(h.kind === "reply" && h.hold).toMatchObject({ waiting: ["Alice"], spoke: { who: "Pat", text: "any news?" } });
  });

  it("a beat can be remembered and is cleared when a round is narrated", () => {
    const r = duo();
    r.beat = { text: "Wolverine coils.", at: 5 };
    say(r, alice, "ready"); say(r, pat, "ready");
    expect(r.beat).toBeUndefined();
  });
});

describe("policy free, token and judged", () => {
  it("free: every message is a round by itself (also the old gate: false)", () => {
    expect(text(say(duo(), pat, "I run", cfg({ turns: "free" })))).toBe("[Pat (actors.p_pat)] I run");
  });

  it("token: only the holder acts; the others are told (note) or kept for the holder's turn (queue)", () => {
    const note = cfg({ turns: "token", offTurn: "note" });
    let r = duo(note);
    expect(text(say(r, pat, "I grab the wand", note, at(1, { token: "user" })))).toBe("It's Alice's turn.");
    expect(r.talk).toEqual([]);
    let s = say(r, alice, "I wave it", note, at(2, { token: "user" }));
    expect(text(s)).toBe("[Alice (actors.user)] I wave it");

    const queue = cfg({ turns: "token", offTurn: "queue" });
    r = duo(queue);
    expect(text(say(r, pat, "wait for me!", queue, at(1, { token: "user" })))).toBe("Queued for Alice's turn.");
    s = say(r, alice, "I wave it", queue, at(2, { token: "user" }));
    expect(text(s)).toBe("[Pat (actors.p_pat)] wait for me!\n[Alice (actors.user)] I wave it");
  });

  it("token: nobody holding it (or an NPC) means anybody may act", () => {
    const c = cfg({ turns: "token" });
    expect(text(say(duo(c), pat, "I act", c, at(1, { token: null })))).toBe("[Pat (actors.p_pat)] I act");
    expect(text(say(duo(c), pat, "I act", c, at(1, { token: "npc_3" })))).toBe("[Pat (actors.p_pat)] I act");
  });

  it("judged: act starts a round, hold and chat do not, and what the story waits on is remembered", () => {
    const c = cfg({ turns: "judged", offTurn: "queue" });
    const r = duo(c);
    expect(text(say(r, pat, "any news?", c, at(1, { verdict: { kind: "chat" } })))).toBe("Noted.");
    expect(text(say(r, pat, "I turn the crane", c, at(2, { verdict: { kind: "hold", awaiting: ["Alice", "Nobody"] } })))).toContain("goes in when your moment comes");
    expect(r.awaiting).toEqual(["u-alice"]);
    const s = say(r, alice, "Crane, move left", c, at(3, { verdict: { kind: "act" } }));
    expect(text(s)).toBe("[Pat (actors.p_pat)] I turn the crane\n[Alice (actors.user)] Crane, move left");
    expect(r.awaiting).toBeUndefined();
    expect(text(say(duo(c), pat, "hello", c, 1))).toBe("[Pat (actors.p_pat)] hello");
  });
});

describe("order of the lines in a round", () => {
  const filled = (c: Cfg) => { const r = mp.newRoom(); mp.join(r, alice, c, 0); mp.join(r, pat, c, 0); mp.join(r, cy, c, 0);
    say(r, cy, "c1", c); say(r, alice, "a1", c); say(r, pat, "b1", c); say(r, alice, "a2", c); say(r, alice, "ready", c); say(r, pat, "ready", c); return say(r, cy, "ready", c); };

  it("fifo (arrival), filo (latest first), join (by who joined, a player's lines stay in order)", () => {
    expect(text(filled(cfg({ order: "fifo" })))).toBe("[Cy (actors.p_cy)] c1\n[Alice (actors.user)] a1\n[Pat (actors.p_pat)] b1\n[Alice (actors.user)] a2");
    expect(text(filled(cfg({ order: "filo" })))).toBe("[Alice (actors.user)] a2\n[Pat (actors.p_pat)] b1\n[Alice (actors.user)] a1\n[Cy (actors.p_cy)] c1");
    expect(text(filled(cfg({ order: "join" })))).toBe("[Alice (actors.user)] a1\n[Alice (actors.user)] a2\n[Pat (actors.p_pat)] b1\n[Cy (actors.p_cy)] c1");
  });

  it("random keeps every line", () => {
    const lines = text(filled(cfg({ order: "random" }))).split("\n").sort();
    expect(lines).toEqual(["[Alice (actors.user)] a1", "[Alice (actors.user)] a2", "[Cy (actors.p_cy)] c1", "[Pat (actors.p_pat)] b1"]);
  });

  it("by an actor field: highest first, or lowest first; players without it go last", () => {
    const init: Record<string, number> = { user: 5, p_pat: 12 };
    const field = (a: string, f: string) => (f === "initiative" ? init[a] : undefined);
    const run = (c: Cfg) => { const r = duo(c); say(r, alice, "a", c); say(r, pat, "b", c); say(r, alice, "ready", c); return say(r, pat, "ready", c, at(5, { field })); };
    expect(text(run(cfg({ order: { by: "initiative", desc: true } })))).toBe("[Pat (actors.p_pat)] b\n[Alice (actors.user)] a");
    expect(text(run(cfg({ order: { by: "initiative", desc: false } })))).toBe("[Alice (actors.user)] a\n[Pat (actors.p_pat)] b");
    const none = (c: Cfg) => { const r = duo(c); say(r, pat, "b", c); say(r, alice, "a", c); say(r, alice, "ready", c); return say(r, pat, "ready", c, at(5, { field: () => undefined })); };
    expect(text(none(cfg({ order: { by: "initiative", desc: true } })))).toBe("[Alice (actors.user)] a\n[Pat (actors.p_pat)] b");
  });
});

describe("stepping away and coming back", () => {
  it("the game stops waiting for someone who steps away; no reason is kept; coming back is speaking again", () => {
    const r = duo();
    say(r, alice, "I search the desk");
    say(r, alice, "ready");
    const away = say(r, pat, "brb, I need some privacy", cfg(), at(1000, { verdict: { kind: "pause" } }));
    expect(away.kind).toBe("round"); // Alice was ready and only Pat was holding the round
    expect(r.players["u-pat"].away).toEqual({ realAt: 1000, gameAt: undefined });
    expect(JSON.stringify(r)).not.toContain("privacy");
    const next = say(r, alice, "ready", cfg(), at(2000));
    expect(text(next)).toContain("[Alice (actors.user)] (ready; says nothing)");
    expect(next.kind === "round" && next.players.map((p) => p.name)).toEqual(["Alice"]);
    expect(text(next)).toContain("NOTE: Away right now (their characters sit out): Pat.");
    const back = say(r, pat, "I'm back, what did I miss?", cfg(), at(1000 + 3 * DAY));
    expect(r.players["u-pat"].away).toBeUndefined();
    expect(back.kind).toBe("reply");
  });

  it("a pause when nobody else was waiting is just noted, and it shows in the status", () => {
    const r = duo();
    expect(text(say(r, pat, "bathroom", cfg(), at(1, { verdict: { kind: "pause" } })))).toBe("Pat has stepped away; the game won't wait for them.");
    expect(text(say(r, alice, "I wait", cfg(), at(2)))).toContain("Away: Pat.");
  });

  it("the round after a return says how long they were gone, in real time and in the story's clock", () => {
    const c = cfg({ turns: "free", clock: { field: "game.minutes", unit: "minute" } });
    const r = duo(c);
    say(r, pat, "gotta go", c, at(0, { game: 100, verdict: { kind: "pause" } }));
    const s = say(r, pat, "I'm back and I open the door", c, at(3 * DAY, { game: 105 }));
    expect(text(s)).toBe("NOTE: Pat is back after 3 days away; in the story 5 minutes passed meanwhile.\n[Pat (actors.p_pat)] I'm back and I open the door");
    const k = cfg({ turns: "free", clock: { field: "game.round", unit: "count" } });
    const q = duo(k);
    say(q, pat, "x", k, at(0, { game: 4, verdict: { kind: "pause" } }));
    expect(text(say(q, pat, "y", k, at(60_000, { game: 5 })))).toContain("after 1 minute away; in the story 1 step passed");
  });

  it("leaving the table is being away until they speak again", () => {
    const r = duo();
    mp.leaveTable(r, "u-pat", at(7, { game: 3 }));
    expect(r.players["u-pat"].away).toEqual({ realAt: 7, gameAt: 3 });
    mp.leaveTable(r, "u-nobody", at(8)); // not at this table: nothing happens
  });
});

describe("private notes and standing instructions (from a player's own chat)", () => {
  const spec = { afterRealMs: 5 * DAY, action: "figures it out with the manual" };

  it("a private note reaches the narrator with the next round, marked, and is then spent", () => {
    const r = duo();
    mp.addNote(r, "u-pat", "I put poison in Alice's cup");
    say(r, alice, "I drink", cfg(), at(1));
    say(r, alice, "ready", cfg(), at(2));
    const s = say(r, pat, "ready", cfg(), at(3));
    expect(text(s)).toBe("[Alice (actors.user)] I drink\n[Pat (actors.p_pat)] PRIVATE, never reveal to the other players: I put poison in Alice's cup");
    expect(r.notes).toEqual([]);
  });

  it("narrator_sees: false keeps the notes from the narrator", () => {
    const c = cfg({ priv: { reply: "ack", narratorSees: false, maxWords: 60, unseated: "ignore", forget: false } });
    const r = duo(c);
    mp.addNote(r, "u-pat", "secret");
    const s = say(r, alice, "go", cfg({ ...c, turns: "free" }), at(1));
    expect(text(s)).toBe("[Alice (actors.user)] go");
    expect(r.notes).toEqual([]);
  });

  it("notes are bounded and ignore people who are not at the table", () => {
    const r = duo();
    for (let i = 0; i < 60; i++) mp.addNote(r, "u-pat", "n" + i);
    expect(r.notes).toHaveLength(40);
    mp.addNote(r, "u-ghost", "who?");
    expect(text(say(r, alice, "x", cfg({ turns: "free" }), at(1)))).not.toContain("who?");
  });

  it("a standing instruction is accepted from a private chat, and from the table only when standing is any", () => {
    const v = { kind: "act" as const, standing: spec };
    const r = duo();
    const pub = mp.applyVerdict(r, r.players["u-pat"], v, cfg(), at(1), false);
    expect(pub.standingSet).toBe(false);
    expect(r.players["u-pat"].standing).toBeUndefined();
    const priv = mp.applyVerdict(r, r.players["u-pat"], v, cfg(), at(2), true);
    expect(priv.standingSet).toBe(true);
    expect(r.players["u-pat"].standing).toEqual({ ...spec, setAt: 2 });
    const any = duo(cfg({ standing: "any" }));
    say(any, pat, "if I don't answer in 5 days, assume I figure it out", cfg({ standing: "any" }), at(1, { verdict: v }));
    expect(any.players["u-pat"].standing).toMatchObject(spec);
    const cleared = mp.applyVerdict(r, r.players["u-pat"], { kind: "act", cancelStanding: true }, cfg(), at(3), true);
    expect(cleared.standingCleared).toBe(true);
    expect(r.players["u-pat"].standing).toBeUndefined();
  });

  it("a pause from a private chat steps them away, and any later message brings them back", () => {
    const r = duo();
    const me = r.players["u-pat"];
    expect(mp.applyVerdict(r, me, { kind: "pause" }, cfg(), at(1, { game: 9 }), true)).toMatchObject({ paused: true });
    expect(me.away).toEqual({ realAt: 1, gameAt: 9 });
    expect(mp.applyVerdict(r, me, { kind: "act" }, cfg(), at(1 + DAY, { game: 9 }), true).back).toContain("Pat is back after 1 day away");
    expect(me.away).toBeUndefined();
  });

  it("the player the game waits on acts on their standing instruction when the real time has passed", () => {
    const r = duo();
    mp.applyVerdict(r, r.players["u-pat"], { kind: "act", standing: spec }, cfg(), at(0), true);
    say(r, alice, "I open the hatch", cfg(), at(0)); // the round opens now
    expect(text(say(r, alice, "ready", cfg(), at(4 * DAY)))).toContain("Waiting for: Pat");
    const s = say(r, alice, "ready", cfg(), at(6 * DAY));
    expect(s.kind).toBe("round");
    expect(text(s)).toBe("[Alice (actors.user)] I open the hatch\n[Pat (actors.p_pat)] (not heard from in 6 days; figures it out with the manual)");
  });

  it("in-game time works too (the story's clock), and either one is enough", () => {
    const c = cfg({ clock: { field: "game.minutes", unit: "minute" } });
    const r = duo(c);
    mp.applyVerdict(r, r.players["u-pat"], { kind: "act", standing: { afterGame: 120, action: "waits" } }, c, at(0, { game: 10 }), true);
    say(r, alice, "I stand guard", c, at(1, { game: 20 }));
    expect(text(say(r, alice, "ready", c, at(2, { game: 100 })))).toContain("Waiting for: Pat");
    expect(text(say(r, alice, "ready", c, at(3, { game: 140 })))).toContain("(not heard from in under a minute; waits)");
  });

  it("the game's default applies to a player who left nothing; nothing fires early", () => {
    const c = cfg({ defaultAfter: { realMs: 2 * DAY }, defaultAction: "sits this one out" });
    const r = duo(c);
    say(r, alice, "I go", c, at(0)); say(r, alice, "ready", c, at(1));
    expect(text(say(r, alice, "ready", c, at(DAY)))).toContain("Waiting for: Pat");
    expect(text(say(r, alice, "ready", c, at(3 * DAY)))).toContain("[Pat (actors.p_pat)] (not heard from in 3 days; sits this one out)");
  });

  it("token: the holder's standing instruction unblocks the game; the others' lines go in with it", () => {
    const c = cfg({ turns: "token", offTurn: "queue" });
    const r = duo(c);
    mp.applyVerdict(r, r.players["u-alice"], { kind: "act", standing: { afterRealMs: DAY, action: "passes the wand" } }, c, at(0), true);
    say(r, pat, "hurry up!", c, at(0, { token: "user" }));
    const s = say(r, pat, "hello??", c, at(2 * DAY, { token: "user" }));
    expect(text(s)).toBe("[Pat (actors.p_pat)] hurry up!\n[Pat (actors.p_pat)] hello??\n[Alice (actors.user)] (not heard from in 2 days; passes the wand)");
  });
});

describe("the transcript", () => {
  it("recordRound with forget drops the private note lines from the transcript and keeps everything else", () => {
    const r = mp.newRoom();
    const text = "[Bea (actors.user)] I call\n[Bo (actors.p_bo)] PRIVATE, never reveal to the other players: I will fold to a raise\n[Cy (actors.p_cy)] hi";
    mp.recordRound(r, text, "Bea calls.", 1, true);
    mp.recordRound(r, text, "Bea calls.", 2);
    expect(String(r.history[0].content)).toBe("[Bea (actors.user)] I call\n[Cy (actors.p_cy)] hi");
    expect(String(r.history[2].content)).toContain("PRIVATE");
  });
  it("recordRound keeps the story, and the last scene is the last narration, shortened", () => {
    const r = duo();
    mp.recordRound(r, "[...]", "The door creaks open onto a long corridor.", 1);
    expect(r.history).toEqual([{ role: "user", content: "[...]" }, { role: "assistant", content: "The door creaks open onto a long corridor." }]);
    expect(r.rounds).toBe(1);
    mp.recordRound(r, "[...]", "x".repeat(500), 2);
    expect(mp.lastScene(r)).toBe("x".repeat(400) + "…");
    expect(mp.lastScene(mp.newRoom())).toBe("");
  });
});

describe("debugRequest", () => {
  it("writes header names and values (secrets hidden), message sizes and the table", () => {
    mp.debugRequest({ "x-openwebui-chat-id": "c1", authorization: "Bearer abc", cookie: "s=1", "x-openwebui-user-id": "u1" }, [{ role: "user", content: "hello there" }], "chat:c1");
    const line = JSON.parse(fs.readFileSync(path.join(process.env.SAVE_DIR!, "multiplayer-debug.jsonl"), "utf8").trim());
    expect(line.table).toBe("chat:c1");
    expect(line.headers).toMatchObject({ "x-openwebui-chat-id": "c1", authorization: "[hidden]", cookie: "[hidden]", "x-openwebui-user-id": "u1" });
    expect(line.messages).toEqual([{ role: "user", chars: 11, start: "hello there" }]);
  });
});
