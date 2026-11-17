import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet");
const { npcAction, strength, aggression } = await import("../src/utils/poker-npc.js");
const { act, leave, playNpcs } = await import("../src/utils/poker-bet.js");
const { leaveSeat } = await import("../src/utils/poker-bet-turn.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");

const table = (hole: string[], over: Record<string, any> = {}, board: string[] = []): any => ({
  game: { phase: "preflop", variant: "holdem", bet_level: 10, big_blind: 10, ...over.game },
  actors: { table: { pot: 30, board }, cy: { name: "Cy", controlled_by: "npc", chips: 200, bet: 0, status: "in", hole, ...over.cy } },
});
const low = (): number => 0.99, high = (): number => 0;

describe("how a server-run seat plays", () => {
  it("with no aggression it keeps the old rule: check free, call a small price, fold a big one", () => {
    expect(aggression(table(["2c", "7d"]))).toBe(0);
    expect(npcAction(table(["As", "Ah"]), "cy", high)).toBe("call");
    expect(npcAction(table(["As", "Ah"], { game: { bet_level: 0 } }), "cy", high)).toBe("check");
    expect(npcAction(table(["As", "Ah"], { game: { bet_level: 150 } }), "cy", high)).toBe("fold");
  });
  it("strength: aces beat seven-deuce, and a made hand beats a pair on the board", () => {
    expect(strength(table(["As", "Ah"]), "cy")).toBeGreaterThan(strength(table(["2c", "7d"]), "cy"));
    const flop = ["Ks", "Kd", "2h"];
    expect(strength(table(["Kc", "Kh"], {}, flop), "cy")).toBeGreaterThan(strength(table(["3c", "9d"], {}, flop), "cy"));
  });
  it("with aggression a strong hand raises (on the dice) and a weak one folds to a big bet", () => {
    const strong = table(["As", "Ah"], { game: { npc_aggression: 1 } });
    expect(npcAction(strong, "cy", high)).toBe("raise");
    expect(npcAction(strong, "cy", low)).toBe("call");
    expect(npcAction(table(["2c", "7d"], { game: { npc_aggression: 1, bet_level: 60 } }), "cy", high)).toBe("fold");
  });
  it("it calls a habitual raiser lighter than a rare one", () => {
    const base = (raises: number): any => table(["9s", "8d"], { game: { npc_aggression: 1, bet_level: 20, last_raiser: "user", npc_stats: { user: { acts: 10, raises } } } });
    expect(npcAction(base(0), "cy", low)).toBe("fold");
    expect(npcAction(base(10), "cy", low)).toBe("call");
  });
  it("act() records who raised and how often; playNpcs raises through act and is capped by the raise limit", async () => {
    const st: any = initialState(); st.actors.cy.status = "in"; st.game.phase = "preflop";
    const dealt: any = await runPhaseHook(st, "registration", "state");
    for (const id of ["bo", "cy", "npc_bo"]) if (dealt.actors[id]) dealt.actors[id].controlled_by = "npc";
    dealt.game.npc_aggression = 1;
    const to = dealt.game.current_actor; dealt.actors[to].controlled_by = "user";
    const r = act(dealt, to, "raise");
    expect(r.ok).toBe(true);
    expect(dealt.game.last_raiser).toBe(to);
    expect(dealt.game.npc_stats[to]).toEqual({ acts: 1, raises: 1 });
    const out = playNpcs(dealt, 24, high);
    expect(out.length).toBeGreaterThan(0);
    expect(dealt.game.raises).toBeLessThanOrEqual(4);
  });
});

describe("leaving mid-hand", () => {
  const deal = async (): Promise<any> => {
    const st: any = initialState(); st.actors.cy.status = "in"; st.game.phase = "preflop";
    return runPhaseHook(st, "registration", "state");
  };
  it("fold (default): the seat folds, its bet stays, and it sits out once the hand is paid", async () => {
    const s = await deal(), id = s.game.current_actor as string;
    const pot = s.actors.table.pot;
    expect(leave(s, id, "fold")).toMatch(/leaves and folds/);
    expect(s.actors[id].status === "folded" || s.game.phase === "showdown").toBe(true);
    if (s.game.phase !== "showdown") { expect(s.game.leavers).toContain(id); expect(s.actors.table.pot).toBeGreaterThanOrEqual(pot); }
    else expect(s.actors[id].status).toBe("sitting out");
  });
  it("split: the seat stays in as all-in for what it bet and cannot win more than a side pot", async () => {
    const s = await deal(), id = s.game.current_actor as string;
    expect(leave(s, id, "split")).toMatch(/leaves and stays in for/);
    expect(s.actors[id].status).toBe("all-in");
    expect(s.game.leavers).toContain(id);
  });
  it("nothing to do outside a hand, or for a seat that already folded", async () => {
    const s = await deal(), id = s.game.current_actor as string;
    s.actors[id].status = "folded";
    expect(leave(s, id, "fold")).toBe("");
    s.game.phase = "between";
    expect(leave(s, "user", "split")).toBe("");
  });
  it("leaveSeat runs the table on after the leaver (a session-level call)", async () => {
    const s: any = { room: { players: {} }, snapshots: [await deal()] };
    const id = s.snapshots[0].game.current_actor as string;
    const text = await leaveSeat(s, id);
    expect(text).toMatch(/leaves/);
    expect(await leaveSeat(s, "nobody")).toBe("");
  });
  it("a split leaver stays in to the showdown, then sits out; chips are conserved", async () => {
    const s: any = { room: { players: {} }, snapshots: [await deal()] };
    const st = s.snapshots[0], sum = (): number => Object.entries<any>(st.actors).filter(([k]) => k !== "table").reduce((n, [, a]) => n + (a.chips || 0), 0) + st.actors.table.pot;
    const before = sum();
    for (const [k, a] of Object.entries<any>(st.actors)) if (k !== "table") a.controlled_by = "npc";
    st.game.leave_rule = "split";
    const id = st.game.current_actor as string;
    await leaveSeat(s, id);
    expect(s.snapshots.at(-1).game.phase).toBe("showdown");
    expect(s.snapshots.at(-1).actors[id].status).toBe("sitting out");
    expect(sum()).toBe(before);
  });
});
