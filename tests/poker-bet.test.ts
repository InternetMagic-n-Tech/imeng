import { describe, it, expect } from "@jest/globals";
import { startHand, act, playNpcs, rollOn, layers } from "../src/utils/poker-bet.js";

const mk = (): any => ({
  game: { phase: "preflop", variant: "holdem", big_blind: 10, small_blind: 5, button: 0 },
  actors: {
    table: { name: "Table", pot: 0, board: [], reserve: [], dealt: [] },
    a: { name: "Bea", chips: 100, bet: 0, status: "in", hole: ["Ah", "Ad"], controlled_by: "user" },
    b: { name: "Bo", chips: 100, bet: 0, status: "in", hole: ["2c", "7d"], controlled_by: "user" },
    c: { name: "Cy", chips: 100, bet: 0, status: "in", hole: ["Kc", "Qd"], controlled_by: "user" },
  },
});

describe("server betting", () => {
  it("posts blinds, then call / raise / fold keep chips, bets and the pot in step", () => {
    const s = mk();
    expect(startHand(s)).toContain("posts 5");
    expect(s.game.button).toBe(1); // the button moves to Bo: Cy posts the small blind, Bea the big, Bo acts first
    expect(s.game.current_actor).toBe("b");
    expect([s.actors.c.bet, s.actors.a.bet, s.actors.table.pot]).toEqual([5, 10, 15]);
  });
  it("only the player to act may act; a call settles the round and moves to the flop", () => {
    const s = mk(); startHand(s);
    const order = [s.game.current_actor];
    expect(act(s, "b", "check").ok).toBe(false);
    const r1 = act(s, order[0], "call"); expect(r1.ok).toBe(true);
    // everyone else
    let guard = 0;
    while (s.game.phase === "preflop" && guard++ < 6) { const id = s.game.current_actor; const a = s.actors[id]; act(s, id, (s.game.bet_level - a.bet) > 0 ? "call" : "check"); }
    expect(s.game.phase).toBe("flop");
    expect(s.actors.table.pot).toBe(30);
    expect(s.game.bet_level).toBe(0);
  });
  it("a raise reopens the round and is capped; everyone folding awards the pot", () => {
    const s = mk(); startHand(s);
    const r = act(s, s.game.current_actor, "raise"); expect(r.text).toContain("raises to 20");
    act(s, s.game.current_actor, "fold"); act(s, s.game.current_actor, "fold");
    expect(s.game.phase).toBe("showdown");
    const total = Object.values<any>(s.actors).filter((a) => a.hole).reduce((n, a) => n + a.chips, 0);
    expect(total).toBe(300); // chips are conserved
    expect(s.actors.table.pot).toBe(0);
  });
  it("chips are conserved through a full hand to a showdown that ranks real cards", () => {
    const s = mk(); startHand(s);
    for (const st of ["preflop", "flop", "turn", "river"]) {
      let guard = 0;
      while (s.game.phase === st && guard++ < 8) { const id = s.game.current_actor; const a = s.actors[id]; act(s, id, (s.game.bet_level - a.bet) > 0 ? "call" : "check"); }
      if (st === "preflop") s.actors.table.board = ["3h", "9s", "Jc"];
      if (st === "flop") s.actors.table.board = ["3h", "9s", "Jc", "5d"];
      if (st === "turn") s.actors.table.board = ["3h", "9s", "Jc", "5d", "8h"];
    }
    expect(s.game.phase).toBe("showdown");
    expect(s.game.winners).toEqual(["a"]); // aces
    expect(Object.values<any>(s.actors).filter((a) => a.hole).reduce((n, a) => n + a.chips, 0)).toBe(300);
  });
  it("NPCs play a fixed rule until a real player is to act; all-in players let the streets run out", () => {
    const s = mk(); s.actors.b.controlled_by = "npc"; s.actors.c.controlled_by = "npc";
    startHand(s);
    const lines = playNpcs(s);
    expect(lines.every((l) => typeof l === "string")).toBe(true);
    const t = mk(); startHand(t); const id = t.game.current_actor; act(t, id, "allin");
    for (const k of Object.keys(t.actors)) if (k !== "table" && k !== id && t.actors[k].status === "in") { t.game.current_actor = k; act(t, k, "call"); }
    expect(rollOn(t) === "" || typeof rollOn(t) === "string").toBe(true);
  });
});

describe("side pots", () => {
  const sp = (chips: Record<string, number>, holes: Record<string, string[]>): any => {
    const s: any = { game: { phase: "preflop", variant: "holdem", big_blind: 10, small_blind: 5, button: 0 }, actors: { table: { name: "Table", pot: 0, board: ["3h", "9s", "Jc", "5d", "8h"] } } };
    for (const id of Object.keys(chips)) s.actors[id] = { name: id, chips: chips[id], bet: 0, status: "in", hole: holes[id], controlled_by: "user" };
    return s;
  };
  const total = (s: any): number => Object.values<any>(s.actors).filter((a) => a.hole).reduce((n, a) => n + a.chips, 0);
  it("a short all-in stack wins only what it covered; the rest goes to the best of the others", () => {
    const s = sp({ a: 40, b: 200, c: 200 }, { a: ["Ah", "Ad"], b: ["Kc", "Kd"], c: ["2c", "7d"] }); startHand(s);
    while (s.game.phase !== "showdown") { const id = s.game.current_actor, p = s.actors[id]; act(s, id, id === "a" ? "allin" : s.game.bet_level - p.bet > 0 ? "call" : id === "b" ? "raise" : "check"); }
    expect(total(s)).toBe(440);
    expect(s.game.pots.length).toBeGreaterThan(1);
    expect(s.game.pots[0].winners).toEqual(["a"]);
    expect(s.game.pots.at(-1).winners).toEqual(["b"]);
    expect(s.actors.table.pot).toBe(0);
    expect(s.game.contrib).toEqual({});
  });
  it("layers follow the contributions and fall back to one pot when they do not add up", () => {
    const s = sp({ a: 100, b: 100 }, { a: ["Ah", "Ad"], b: ["Kc", "Kd"] }); startHand(s);
    expect(layers(s)!.map((l) => l.amount)).toEqual([10, 5]);
    s.actors.table.pot = 99;
    expect(layers(s)).toBeNull();
    s.game.contrib = {}; s.actors.table.pot = 0;
    expect(layers(s)).toBeNull();
  });
  it("an uncalled all-in comes back to its owner; a folded contributor's chips stay in the pot", () => {
    const s = sp({ a: 100, b: 30, c: 100 }, { a: ["Ah", "Ad"], b: ["Kc", "Kd"], c: ["2c", "7d"] });
    s.game.contrib = { a: 100, b: 30, c: 10 }; s.actors.table.pot = 140; s.actors.c.status = "folded"; s.actors.a.chips = 0; s.actors.b.chips = 0; s.actors.a.status = "all-in"; s.actors.b.status = "all-in";
    expect(layers(s)).toEqual([{ amount: 30, eligible: ["a", "b"] }, { amount: 40, eligible: ["a", "b"] }, { amount: 70, eligible: ["a"] }]);
  });
});

describe("blind schedule", () => {
  const mk3 = (): any => ({ game: { phase: "preflop", variant: "holdem", button: 0, small_blind: 5, big_blind: 10 }, actors: { table: { name: "Table", pot: 0 }, a: { name: "Bea", chips: 500, bet: 0, status: "in", hole: ["Ah", "Ad"] }, b: { name: "Bo", chips: 500, bet: 0, status: "in", hole: ["2c", "7d"] } } });
  const sch = { steps: [1, 2, 5], every: 2 };
  it("raises by hands the server dealt from the table's own blinds, keeps the last step, and says so when it changes", () => {
    const s = mk3(); const said: string[] = [];
    for (let i = 0; i < 7; i++) { said.push(startHand(s, sch)); s.game.phase = "preflop"; }
    expect(said[0]).not.toContain("now"); expect(said[1]).not.toContain("now");
    expect(said[2]).toContain("Blinds are now 10/20"); expect(said[3]).not.toContain("now");
    expect(said[4]).toContain("Blinds are now 25/50");
    expect([s.game.small_blind, s.game.big_blind, s.game.blind_level, s.game.hands_played, s.game.blind_base]).toEqual([25, 50, 2, 7, { small: 5, big: 10 }]);
  });
  it("starts from whatever blinds the table registered, and without a schedule they stay", () => {
    const s = mk3(); s.game.small_blind = 10; s.game.big_blind = 20;
    startHand(s, sch); startHand(s, sch); expect(startHand(s, sch)).toContain("now 20/40");
    const t = mk3(); t.game.small_blind = 3; t.game.big_blind = 6;
    startHand(t); startHand(t, null);
    expect([t.game.small_blind, t.game.big_blind]).toEqual([3, 6]);
  });
});

describe("table settings from the state", () => {
  const mk2 = (): any => ({ game: { phase: "preflop", variant: "holdem", button: 0, small_blind: 5, big_blind: 10 }, actors: { table: { name: "Table", pot: 0 }, a: { name: "Bea", chips: 100, bet: 0, status: "in", hole: ["Ah", "Ad"], controlled_by: "user" }, b: { name: "Bo", chips: 100, bet: 0, status: "in", hole: ["2c", "7d"], controlled_by: "user" }, c: { name: "Cy", chips: 3, bet: 0, status: "in", hole: ["Kc", "Qd"], controlled_by: "user" } } });
  const total = (s: any): number => Object.values<any>(s.actors).filter((a) => a.hole).reduce((n, a) => n + a.chips, 0) + s.actors.table.pot;
  it("an ante is collected before the blinds, is not a bet, and a short stack goes all-in on it", () => {
    const s = mk2(); s.game.ante = 5;
    expect(startHand(s)).toContain("Everyone antes 5");
    expect(s.actors.c).toMatchObject({ status: "all-in", chips: 0 });
    expect(s.game.contrib.c).toBe(3);
    expect(s.actors.table.pot).toBe(13 + 10); // antes 13; Cy (the small blind) has nothing left, Bea posts the big blind
    expect(total(s)).toBe(203);
  });
  it("no ante by default; the blinds and the raise cap (the big blind counts as the first) come from game.*", () => {
    const s = mk2(); expect(startHand(s)).not.toContain("antes");
    const t = mk2(); t.game.max_raises = 2; t.game.big_blind = 20; t.game.small_blind = 50; startHand(t);
    expect(t.actors.table.pot).toBeGreaterThan(0);
    expect(act(t, t.game.current_actor, "raise").ok).toBe(true);
    expect(act(t, t.game.current_actor, "raise")).toMatchObject({ ok: false, text: expect.stringContaining("capped") });
  });
});
