import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/shuffle");
const { shuffleCommand } = await import("../src/utils/audience.js");
const { auditCommand } = await import("../src/utils/audit.js");
const { allowed } = await import("../src/utils/phases.js");
const { runPhaseHook } = await import("../src/utils/phase-hook.js");
const { initialState } = await import("../src/utils/state.js");
const mk = (): any => { const st: any = initialState(); st.actors.dee = { name: "Dee", role: "dealer", controlled_by: "user", chips: 0 }; return { owner: { userId: "u-bea" }, room: { players: { "u-dee": { actor: "dee" }, "u-bo": { actor: "bo" } } }, snapshots: [st] }; };
const bea = { userId: "u-bea", name: "Bea" } as any, dee = { userId: "u-dee", name: "Dee" } as any, bo = { userId: "u-bo", name: "Bo" } as any;

describe("shuffle ritual as a gate", () => {
  it("only the dealer (or the house) shuffles; steps must be in order; the game is blocked until the last is done", () => {
    const s = mk();
    expect(shuffleCommand("riffle 7", { session: s, who: bo })).toContain("Only the dealer");
    expect(allowed(s.snapshots[0], "registration", "preflop")).toBe(false); // blocked
    expect(shuffleCommand("cut", { session: s, who: dee })).toContain("Not that");
    expect(shuffleCommand("Riffle  7", { session: s, who: dee })).toContain("Next: /shuffle cut");
    expect(shuffleCommand("cut", { session: s, who: bea })).toContain("The deck is shuffled");
    expect(allowed(s.snapshots[0], "registration", "preflop")).toBe(true);
    expect(shuffleCommand("cut", { session: s, who: dee })).toContain("already shuffled");
  });
  it("the deal uses the shuffle once and the next hand needs a new one", async () => {
    const s = mk(); shuffleCommand("riffle 7", { session: s, who: dee }); shuffleCommand("cut", { session: s, who: dee });
    const st = s.snapshots[0]; st.actors.user.chips = 100; st.actors.table = { name: "Table", reserve: [], board: [], dealt: [], controlled_by: "npc" }; st.actors.bo = { name: "Bo", chips: 100, status: "in", hole: [], controlled_by: "npc" };
    st.game.phase = "preflop";
    const r: any = await runPhaseHook(st, "registration", "state");
    expect(r.actors.user.hole).toHaveLength(2);
    expect(r.game.shuffled).toBe(0);
    expect(r.game.shuffle_step).toBe(0);
  });
  it("the house can read what happened, privately; nobody else can", async () => {
    const s = mk(); shuffleCommand("riffle 7", { session: s, who: dee }); shuffleCommand("cut", { session: s, who: dee });
    const st = s.snapshots[0]; st.actors.user.chips = 100; st.actors.table = { name: "Table", reserve: [], board: [], dealt: [], controlled_by: "npc" }; st.actors.bo = { name: "Bo", chips: 100, status: "in", hole: [], controlled_by: "npc" };
    st.game.phase = "preflop"; st.game.hand = 1;
    await runPhaseHook(st, "registration", "state", undefined, s);
    expect(await auditCommand(s, bo)).toContain("Only the house");
    expect(await auditCommand(s, bea)).toBe("The audit was sent to the house privately.");
    const note = s.announcements.at(-1);
    expect(note.to).toBe("u-bea");
    expect(note.text).toContain('Dee ran "riffle 7"');
    expect(note.text).toContain("board set aside face down");
    expect(note.text).toMatch(/dealt [0-9AJQK]+[cdhs] [0-9AJQK]+[cdhs]/);
  });
});
