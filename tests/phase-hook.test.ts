import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/phase-hook");
const { phaseCommand, mayProduce } = await import("../src/utils/hazards-turn.js");
const { initialState } = await import("../src/utils/state.js");
const mk = (): any => { const st: any = initialState(); st.actors.pro = { name: "Pat", role: "producer", controlled_by: "user" }; return { owner: { userId: "u-bea" }, room: { players: { "u-pat": { actor: "pro" } } }, snapshots: [st] }; };
const bea = { userId: "u-bea", name: "Bea" } as any, pat = { userId: "u-pat", name: "Pat" } as any, bo = { userId: "u-bo", name: "Bo" } as any;

describe("producer phase commands", () => {
  it("per-command permission: move may be the producer role, end stays with the owner", () => {
    const s = mk();
    expect(mayProduce(s, pat, "move")).toBe(true);
    expect(mayProduce(s, pat, "end")).toBe(false);
    expect(mayProduce(s, bo, "move")).toBe(false);
    expect(mayProduce(s, bea, "end")).toBe(true);
  });
  it("/move applies the hook's operations once, even if the signal arrives twice", async () => {
    const s = mk();
    expect(await phaseCommand("move", "the dome", { session: s, who: pat, signal: "a1" })).toContain("moved");
    expect(s.snapshots[0].game.place).toBe("the dome");
    expect(await phaseCommand("move", "the dome", { session: s, who: pat, signal: "a1" })).toBe("");
  });
  it("/end goes to the finale and the hook sets the place; a stranger is refused", async () => {
    const s = mk();
    expect(await phaseCommand("end", "", { session: s, who: bo })).toContain("Only the producer");
    await phaseCommand("end", "", { session: s, who: bea });
    expect(s.snapshots[0].game.phase).toBe("finale");
    expect(s.snapshots[0].game.place).toBe("the studio");
  });
});
