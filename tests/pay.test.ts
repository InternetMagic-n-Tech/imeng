import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/bet");
const { payCommand } = await import("../src/utils/pay.js");
const { parseCommand } = await import("../src/utils/commands.js");
const { PAY } = await import("../src/utils/config.js");

beforeEach(() => { for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });
const st = (phase = "between"): any => ({ game: { phase }, actors: {
  table: { name: "Table" },
  user: { name: "Bea", chips: 100, controlled_by: "user" },
  p_bo: { name: "Bo Lee", chips: 5, controlled_by: "other_player" },
  npc_cy: { name: "Cy", chips: 50, controlled_by: "npc" } } });
const sess = (s: any): any => ({ snapshots: [s], room: { players: { u1: { userId: "u1", name: "Bea", actor: "user" }, u2: { userId: "u2", name: "Bo Lee", actor: "p_bo" } } } });
const bea = { userId: "u1", name: "Bea" };

describe("/pay", () => {
  it("is configured, and /pay is a command", () => {
    expect(PAY).toMatchObject({ field: "chips", phases: ["between", "registration"] });
    expect(parseCommand("/pay Bo 5")).toMatchObject({ name: "pay", arg: "Bo 5" });
  });
  it("moves whole chips between two seated people, by name (with spaces), id or a $ amount", async () => {
    const s = st(), x = sess(s);
    expect(await payCommand(x, bea, "Bo Lee 30")).toBe("Bea pays Bo Lee 30.");
    expect([s.actors.user.chips, s.actors.p_bo.chips]).toEqual([70, 35]);
    expect(await payCommand(x, bea, "p_bo $10")).toBe("Bea pays Bo Lee 10.");
    expect([s.actors.user.chips, s.actors.p_bo.chips]).toEqual([60, 45]);
    expect(await payCommand(x, { userId: "u2", name: "Bo Lee" }, "bea 45")).toBe("Bo Lee pays Bea 45.");
  });
  it("refuses a bad amount, too much, yourself, an NPC, a stranger, a wrong phase and a person who is not seated", async () => {
    const s = st(), x = sess(s);
    expect(await payCommand(x, bea, "")).toMatch(/Say \/pay/);
    expect(await payCommand(x, bea, "Bo")).toMatch(/Say \/pay/);
    expect(await payCommand(x, bea, "Bo 0")).toMatch(/Say \/pay/);
    expect(await payCommand(x, bea, "Bo 1.5")).toMatch(/Say \/pay/);
    expect(await payCommand(x, bea, "Bo 101")).toBe("You do not have that much.");
    expect(await payCommand(x, bea, "Bea 5")).toBe("You cannot pay yourself.");
    expect(await payCommand(x, bea, "Cy 5")).toMatch(/nobody called "Cy"/);
    expect(await payCommand(x, bea, "Zed 5")).toMatch(/nobody called "Zed"/);
    expect(await payCommand(x, { userId: "zz", name: "Zed" }, "Bo 5")).toBe("You are not seated at this table.");
    s.game.phase = "flop";
    expect(await payCommand(x, bea, "Bo 5")).toBe("Payments are not allowed right now.");
    expect([s.actors.user.chips, s.actors.p_bo.chips]).toEqual([100, 5]);
  });

  it("escrow: hold takes the chips, release (any phase) pays the payee, refund returns them where payments are allowed", async () => {
    const s = st(), x = sess(s);
    expect(await payCommand(x, bea, "hold Bo 30")).toMatch(/Bea puts 30 in escrow for Bo Lee/);
    expect([s.actors.user.chips, s.actors.p_bo.chips, s.game.escrow, s.game.escrow_total]).toEqual([70, 5, [{ from: "user", to: "p_bo", amount: 30 }], 30]);
    expect(await payCommand(x, bea, "refund")).toMatch(/Bea takes 30 back/);
    expect([s.actors.user.chips, s.game.escrow, s.game.escrow_total]).toEqual([100, undefined, undefined]);
    await payCommand(x, bea, "hold Bo 40");
    s.game.phase = "dance"; // a dance in progress: the payer can still release to be nice, but cannot take it back
    expect(await payCommand(x, bea, "refund")).toBe("It is too late to take it back.");
    expect(await payCommand(x, bea, "hold Bo 1")).toMatch(/not allowed|held/i);
    expect(await payCommand(x, { userId: "u2", name: "Bo" }, "release")).toBe("You have nothing in escrow.");
    expect(await payCommand(x, bea, "release")).toBe("Bea releases 40 to Bo Lee.");
    expect([s.actors.user.chips, s.actors.p_bo.chips, s.game.escrow]).toEqual([60, 45, undefined]);
  });

  it("escrow: leaving a release_on phase pays it out; a payee who is gone gets nothing, the payer is refunded", async () => {
    const { runPhaseHook } = await import("../src/utils/phase-hook.js");
    const { releaseEscrow } = await import("../src/utils/pay.js");
    const { initialState } = await import("../src/utils/state.js");
    const s: any = initialState();
    Object.assign(s.actors, { user: { name: "Bea", chips: 75, controlled_by: "user" }, p_bo: { name: "Bo Lee", chips: 5, controlled_by: "other_player" } });
    s.game.escrow = [{ from: "user", to: "p_bo", amount: 25 }];
    s.game.phase = "registration"; // leaving between (no hand is dealt, so the chips stay as released)
    const out: any = await runPhaseHook(s, "between");
    expect([out.actors.user.chips, out.actors.p_bo.chips, out.game.escrow]).toEqual([75, 30, undefined]);
    const gone: any = st(); gone.game.escrow = [{ from: "user", to: "p_zed", amount: 25 }]; gone.actors.user.chips = 75;
    expect(releaseEscrow(gone)).toEqual(["Bea takes 25 back from escrow."]);
    expect(gone.actors.user.chips).toBe(100);
  });
});
