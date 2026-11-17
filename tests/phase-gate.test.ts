import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/phase-gate");
jest.spyOn(console, "log").mockImplementation(() => {});
jest.spyOn(console, "warn").mockImplementation(() => {});

const { initialState, applyOps } = await import("../src/utils/state.js");
const { PHASES, PROTECTED_GAME_PATHS } = await import("../src/utils/config.js");
const { gatedPhase, phaseBlock } = await import("../src/utils/phases.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { idleVote } = await import("../src/utils/idle-vote.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");

const go = (s: any, phase: string) => applyOps(s, [{ op: "set", path: "game.phase", value: phase }]).state as any;

describe("gated phases and routes", () => {
  it("parses routes with operations, and a gate needs a way out", () => {
    expect(PHASES!.dance).toMatchObject({ gated: { blocks: ["interrupt", "idle", "producer", "deal", "pay"] }, maxRounds: "game.limit", next: ["play"] });
    expect(PHASES!.dance.routes.play).toEqual([{ op: "set", path: "game.dance", value: "" }]);
    expect(PHASES!.stuck.gated).toBeNull(); // no next route: not gated
    expect(PHASES!.play.gated).toBeNull();
  });

  it("a gated phase cannot be interrupted or left except along its route", () => {
    let s = go(initialState(), "dance");
    expect(gatedPhase(s)).toBe("dance");
    expect(go(s, "storm").game.phase).toBe("dance"); // an interrupt phase would normally be enterable from anywhere
    expect(go(s, "stuck").game.phase).toBe("dance");
    expect(go(s, "play").game.phase).toBe("play");
    expect(go(initialState(), "storm").game.phase).toBe("storm"); // from an ungated phase it still is
    expect(phaseBlock(s)).toMatch(/held in the dance phase/);
  });

  it("the route's operations run as soon as the game arrives", async () => {
    let s = go(initialState(), "dance");
    s.game.dance = "Bo for Bea";
    const out: any = await runPhaseHook(go(s, "play"), "dance");
    expect(out.game.phase).toBe("play");
    expect(out.game.dance).toBe("");
  });

  it("ends by itself after max_rounds, and the counter is the server's", () => {
    let s = go(initialState(), "dance");
    s = applyOps(s, []).state as any;
    expect(s.game.phase_rounds).toBe(1);
    expect(PROTECTED_GAME_PATHS).toContain("game.phase_rounds");
    s = applyOps(s, []).state as any;
    expect(s.game.phase).toBe("play");
    expect(s.game.phase_rounds).toBeUndefined();
  });

  it("a gate holds back only what it lists, and only while its `when` is true", () => {
    let s = go(initialState(), "tango");
    expect(gatedPhase(s, "idle")).toBeNull(); // hold is false
    s.game.hold = 1;
    expect(gatedPhase(s, "idle")).toBe("tango");
    expect(gatedPhase(s, "deal")).toBe("tango");
    expect(gatedPhase(s, "pay")).toBeNull(); // not listed
    expect(go(s, "storm").game.phase).toBe("storm"); // "interrupt" is not listed, so an interrupt may preempt it
    expect(gatedPhase(go(initialState(), "dance"), "pay")).toBe("dance");
  });

  it("an idle vote cannot move a gated phase on", () => {
    const room = newRoom();
    join(room, { userId: "u1", name: "Bea" }, MULTIPLAYER!, 0);
    const session: any = { room, snapshots: [go(initialState(), "dance")] };
    expect(idleVote(session, { userId: "u2", name: "Bo" }, { now: 10 * 60_000 })).toMatch(/held in the dance phase/);
    session.snapshots = [initialState()];
    expect(idleVote(session, { userId: "u2", name: "Bo" }, { now: 10 * 60_000 })).not.toMatch(/held in/);
  });

  it("private narration: the people named by the escrow get it, a flag turns it off, and the pair is remembered once the escrow is gone", async () => {
    const { privateNarration } = await import("../src/utils/private-narration.js");
    const session: any = { room: { players: { u1: { userId: "u1", actor: "user" }, u2: { userId: "u2", actor: "p_bo" }, u3: { userId: "u3", actor: "p_cy" } } } };
    const s = go(initialState(), "dance");
    expect(privateNarration(session, s)).toBeNull(); // nobody to send it to: the table reads it
    s.game.escrow = [{ from: "user", to: "p_bo", amount: 10 }];
    expect(privateNarration(session, s)).toEqual({ line: "A private dance is on.", to: ["u1", "u2"] });
    delete s.game.escrow; // released mid-dance
    expect(privateNarration(session, s)?.to).toEqual(["u1", "u2"]);
    s.game.pub = 1;
    expect(privateNarration(session, s)).toBeNull(); // both agreed it is public
    const back = go(s, "play");
    back.game.private_to = ["user"];
    expect(privateNarration(session, back)).toBeNull(); // play: `when` (pub >= 5) does not hold
    expect(back.game.private_to).toBeUndefined();
    const plain: any = go(initialState(), "tango"); plain.game.private_to = ["user"];
    expect(privateNarration(session, plain)).toBeNull(); // a phase without private_narration forgets the pair
    expect(plain.game.private_to).toBeUndefined();
  });
});

describe("the off-phase gate accepts a small judge's loose answers", () => {
  it("a listed name, a word from the description, or the one action of a phase fit; none and strangers do not", async () => {
    const { actionFits } = await import("../src/utils/gate.js");
    const two = [{ name: "fight", describe: "attack, defend, cast a spell, use an item, flee or help someone" }, { name: "talk", describe: "speak to someone" }];
    expect(actionFits("fight", two)).toBe(true);
    expect(actionFits("Attack", two)).toBe(true); // a word of one action's description
    expect(actionFits("cast a spell", two)).toBe(true);
    expect(actionFits("none", two)).toBe(false);
    expect(actionFits("heal", two)).toBe(false); // names nothing listed, and the phase has two actions
    expect(actionFits("heal", [two[0]])).toBe(true); // one action here: the judge saw an attempt
    expect(actionFits("none", [two[0]])).toBe(false);
    expect(actionFits("", two)).toBe(false);
    expect(actionFits("a.b(", two)).toBe(false); // not a pattern
  });
});
