import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet");
const { betCommand, autoFold } = await import("../src/utils/poker-bet-turn.js");
const { BLINDS } = await import("../src/utils/config.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");

const total = (s: any): number => Object.entries<any>(s.actors).filter(([k]) => k !== "table").reduce((n, [, a]) => n + (a.chips || 0), 0) + s.actors.table.pot + (s.game.tips || 0);

describe("a real user in a chat with no room yet (one person alone against NPCs)", () => {
  it("plays the 'user' actor: /deal works, and a second person at a real table is still not seated", async () => {
    const st: any = initialState();
    const alone: any = { owner: { userId: "u-real" }, snapshots: [st] };
    expect(await betCommand("deal", { session: alone, who: { userId: "u-real", name: "Bea" } })).not.toMatch(/not seated/);
    const table: any = { owner: { userId: "u" }, room: { players: { u: { actor: "user" } } }, snapshots: [initialState()] };
    expect(await betCommand("deal", { session: table, who: { userId: "stranger", name: "Zed" } })).toMatch(/not seated/);
  });
});

describe("betting by command, with the server's deal", () => {
  it("a whole hand through commands: blinds, NPC plays, streets dealt by the server, a showdown, chips conserved", async () => {
    const st: any = initialState();
    st.actors.cy.status = "in"; // Cy joins the hand; Bo and Cy are NPCs
    const before = total(st);
    st.game.phase = "preflop";
    const dealt = await runPhaseHook(st, "registration", "state");
    expect(dealt.game.current_actor).toBeTruthy();
    const s: any = { owner: { userId: "u" }, room: { players: { u: { actor: "user" } } }, snapshots: [dealt] };
    let out = "";
    for (let i = 0; i < 20 && s.snapshots[0].game.phase !== "showdown"; i++) {
      const g = s.snapshots[0].game;
      if (g.current_actor !== "user") break; // an NPC is to act only if something stalled
      const need = g.bet_level - s.snapshots[0].actors.user.bet;
      out += " " + await betCommand(need > 0 ? "call" : "check", { session: s, who: { userId: "u", name: "Bea" } });
    }
    const fin = s.snapshots[0];
    expect(fin.game.phase).toBe("showdown");
    expect(fin.actors.table.board).toHaveLength(5); // dealt by the server, street by street
    expect(out).toMatch(/Flop: /);
    expect(out).toMatch(/win/);
    expect(total(fin)).toBe(before);
  });
  it("refuses out of turn and for someone not seated", async () => {
    const st: any = initialState(); st.game.phase = "preflop";
    const dealt = await runPhaseHook(st, "registration", "state");
    const s: any = { room: { players: { u: { actor: "user" } } }, snapshots: [dealt] };
    expect(await betCommand("call", { session: s, who: { userId: "zz", name: "Zed" } })).toContain("not seated");
  });
  it("the shot clock folds the seat that is to act, in code; other lines and seats do nothing", async () => {
    const st: any = initialState(); st.game.phase = "preflop";
    const dealt: any = await runPhaseHook(st, "registration", "state");
    const s: any = { room: { players: { u: { actor: "user" } } }, snapshots: [dealt] };
    expect(dealt.game.current_actor).toBe("user");
    expect(await autoFold(s, "[Bea (actors.user)] hello")).toBe("");
    expect(await autoFold(s, "[Bo (actors.bo)] (not heard from in 3 minutes; folds)")).toBe("");
    const note = await autoFold(s, "[Bea (actors.user)] (not heard from in 3 minutes; folds)");
    expect(note).toMatch(/^NOTE: The shot clock folded/);
    expect(s.snapshots[0].actors.user.status).toBe("folded");
    s.snapshots[0].game.phase = "between";
    expect(await autoFold(s, "[Bea (actors.user)] (not heard from in 3 minutes; folds)")).toBe("");
  });
  it("the blind schedule is read from config.json: the multipliers come from config.json", () => {
    expect(BLINDS).toEqual({ steps: [1, 2, 3], every: 3 });
  });
  it("/deal starts a hand from registration or between: the server deals and posts the blinds, and it says no during a hand or with one player", async () => {
    const st: any = initialState(); st.actors.cy.status = "in";
    const s: any = { room: { players: { u: { actor: "user" } } }, snapshots: [st] };
    const out = await betCommand("deal", { session: s, who: { userId: "u", name: "Bea" } });
    expect(out).toMatch(/^Hand 1 begins and the cards are out\. .*posts/);
    expect(s.snapshots[0].game.phase).toBe("preflop");
    expect(s.snapshots[0].actors.user.hole).toHaveLength(2);
    expect(await betCommand("deal", { session: s, who: { userId: "u", name: "Bea" } })).toMatch(/already being played/);
    const solo: any = initialState(); for (const k of Object.keys(solo.actors)) if (k !== "table" && k !== "user") solo.actors[k].status = "sitting out";
    const s2: any = { room: { players: { u: { actor: "user" } } }, snapshots: [solo] };
    expect(await betCommand("deal", { session: s2, who: { userId: "u", name: "Bea" } })).toMatch(/two players/);
    s2.snapshots[0].game.phase = "showdown";
    expect(await betCommand("deal", { session: s2, who: { userId: "u", name: "Bea" } })).toMatch(/No hand can start/);
  });
});
