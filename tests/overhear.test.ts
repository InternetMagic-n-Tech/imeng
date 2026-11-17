import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/knowledge-overhear");
const { KNOWLEDGE } = await import("../src/utils/config.js");
const K = await import("../src/utils/knowledge.js");
const { newRoom } = await import("../src/utils/multiplayer.js");

const cfg = KNOWLEDGE!;
const state = (): any => ({ game: { exited_game: [] }, actors: {
  user: { name: "Bea", controlled_by: "user" },
  npc_a: { name: "Ada", controlled_by: "npc", nosiness: 0, respects_privacy: 0 },
  npc_b: { name: "Bix", controlled_by: "npc", nosiness: 0, respects_privacy: 0 },
  npc_c: { name: "Cy", controlled_by: "npc", nosiness: 0, respects_privacy: 0 },
  npc_d: { name: "Dot", controlled_by: "npc", nosiness: 0, respects_privacy: 0 },
} });
const setup = (): { s: any; f: any } => {
  const s: any = { room: newRoom(), snapshots: [] };
  const k = K.storeOf(s, cfg);
  const f = { id: "f1", text: "the vault code is 1234", about: "npc_a", knownBy: ["npc_a", "npc_b"], access: "roleplaying", watch: [], discover: [], createdBy: "game", createdTurn: 1 };
  k.facts.push(f as any);
  return { s, f };
};

describe("overhearing a whisper", () => {
  it("is read from config.json", () => {
    expect(cfg.overhear).toMatchObject({ base: 0.2, step: 0.3, seek: 0.7, nosyField: "nosiness", respectField: "respects_privacy" });
    expect(cfg.overhear!.text).toContain("{what}");
  });
  it("every other NPC witnesses it (the narrator is told), the parties do not roll", async () => {
    const { s, f } = setup();
    const out = await K.overhear(s, cfg, state(), f, "npc_a", ["npc_b"], "whisper", 1, () => 0.99);
    expect(out.map((l) => l.split(" ")[0]).sort()).toEqual(["Cy", "Dot"]);
    expect(s.room.overheard).toHaveLength(2);
    expect(f.knownBy).toEqual(["npc_a", "npc_b"]);
    expect(out[0]).toContain("saw but did not catch");
    expect(out[0]).not.toContain("1234");
  });
  it("a hit is a fragment kept as its own fact known only to the listener, never the whole thing", async () => {
    const { s, f } = setup();
    await K.overhear(s, cfg, state(), f, "npc_a", ["npc_b"], "whisper", 1, () => 0.1);
    const mine = K.storeOf(s, cfg).facts.filter((x: any) => x.createdBy === "game" && x.about === "npc_a" && x.id !== "f1");
    expect(mine.map((x: any) => x.knownBy[0]).sort()).toEqual(["npc_c", "npc_d"]);
    for (const x of mine) { expect(x.text).not.toBe(f.text); expect(x.text).toMatch(/…/); expect(x.about).toBe("npc_a"); }
    expect(f.knownBy).toEqual(["npc_a", "npc_b"]);
    expect(s.room.overheard[0]).toContain("caught only a fragment");
  });
  it("nosiness raises the chance and a nosy NPC moves closer; respect lowers it", async () => {
    const { s, f } = setup(), st = state();
    st.actors.npc_c.nosiness = 0.8; st.actors.npc_d.respects_privacy = 1;
    // p(Cy) = 0.2 + 0.3*0.8 + 0.3 = 0.74; p(Dot) = 0.2 + 0.3*(0-1) = 0
    await K.overhear(s, cfg, st, f, "npc_a", ["npc_b"], "whisper", 1, () => 0.7);
    const heardBy = K.storeOf(s, cfg).facts.filter((x: any) => x.createdBy === "game" && x.about === "npc_a" && x.id !== "f1").map((x: any) => x.knownBy[0]);
    expect(heardBy).toEqual(["npc_c"]);
    expect(s.room.overheard.find((l: string) => l.startsWith("Cy"))).toContain("moved closer");
  });
  it("a real player at the table is a listener too: told privately a fragment, by the same dice; an away player is not", async () => {
    const { s, f } = setup(), st = state();
    s.room.players = { u1: { userId: "u1", name: "Bea", actor: "user" } , u9: { userId: "u9", name: "Ghost", actor: "p_ghost", away: { realAt: 0, gameAt: 0 } } };
    st.actors.p_ghost = { name: "Ghost", controlled_by: "other_player" };
    await K.overhear(s, cfg, st, f, "npc_a", ["npc_b"], "whisper", 1, () => 0.1);
    expect(s.announcements.map((e: any) => [e.kind, e.to])).toEqual([["overheard", "u1"]]);
    expect(s.announcements[0].text).toMatch(/fragment/);
    expect(s.announcements[0].text).toContain("Ada whispers to Bix");
    expect(s.announcements[0].text).toMatch(/…/);
    const lines = s.room.overheard.map((l: string) => l.split(" ")[0]);
    expect(lines).toEqual(expect.arrayContaining(["Bea", "Cy", "Dot"]));
    expect(lines).not.toContain("Ghost");
    const miss = setup();
    miss.s.room.players = { u1: { userId: "u1", name: "Bea", actor: "user" } };
    await K.overhear(miss.s, cfg, state(), miss.f, "npc_a", ["npc_b"], "whisper", 1, () => 0.99);
    expect(miss.s.announcements ?? []).toEqual([]); // a miss tells them nothing more than the table notice
  });
  it("an exited NPC is not there; no room or no setting does nothing", async () => {
    const { s, f } = setup(), st = state();
    st.game.exited_game = [{ id: "npc_c" }];
    expect((await K.overhear(s, cfg, st, f, "npc_a", ["npc_b"], "whisper", 1, () => 0)).map((l) => l.split(" ")[0])).toEqual(["Dot"]);
    expect(await K.overhear({ snapshots: [] } as any, cfg, st, f, "npc_a", ["npc_b"], "whisper", 1)).toEqual([]);
    expect(await K.overhear(s, { ...cfg, overhear: null }, st, f, "npc_a", ["npc_b"], "whisper", 1)).toEqual([]);
  });
});

describe("fragment: rarely perfect information", () => {
  it("keeps some of the words in order, with gaps marked, never all and never none", () => {
    const text = "omg I love it when guys love pink";
    for (let seed = 1; seed < 40; seed++) {
      let x = seed; const r = (): number => (x = (x * 16807) % 2147483647) / 2147483647;
      const out = K.fragment(text, r);
      const kept = out.replace(/…/g, " ").split(/\s+/).filter(Boolean);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(text.split(" ").length);
      let at = -1; for (const w of kept) { const i = text.split(" ").indexOf(w, at + 1); expect(i).toBeGreaterThan(at); at = i; }
      expect(out).toMatch(/…/);
    }
    expect(K.fragment("hi", () => 0.5)).toBe("hi");
    expect(K.fragment("", () => 0.5)).toBe("");
  });
});

describe("the producer's debrief beat", () => {
  it("is read from config.json", () => { expect(cfg.debrief).toMatchObject({ phases: ["crossing"] }); expect(cfg.debrief!.ask).toContain("{what}"); });
  it("what passed and what each NPC gathered wait in the room until the beat", async () => {
    const { s, f } = setup();
    K.noteSeen(s, cfg, "Ada", ["Bix"], "whisper");
    K.noteSeen(s, cfg, "Ada", ["Bix"], "whisper"); // the same sight again is not a second line in the producer's question
    await K.overhear(s, cfg, state(), f, "npc_a", ["npc_b"], "whisper", 1, () => 0.1); // Cy and Dot catch it
    expect(s.room.debrief.seen).toEqual(["Ada whispers to Bix"]);
    expect(s.room.debrief.npc[0]).toMatch(/gathered: "…/);
    const miss = setup();
    await K.overhear(miss.s, cfg, state(), miss.f, "npc_a", ["npc_b"], "whisper", 1, () => 0.99);
    expect(miss.s.room.debrief.npc[0]).toContain("only saw that Ada whispers to Bix");
  });
  it("the beat asks every real player present privately, tells the narrator about the NPCs, writes no knowledge and clears the queue", async () => {
    const { s, f } = setup();
    s.room.players = { u1: { userId: "u1", name: "Bea", actor: "user" }, u2: { userId: "u2", name: "Bo", actor: "p_bo", away: { realAt: 0, gameAt: 0 } } };
    K.noteSeen(s, cfg, "Ada", ["Bix"], "whisper");
    await K.overhear(s, cfg, state(), f, "npc_a", ["npc_b"], "whisper", 1, () => 0.99);
    const known = JSON.stringify(f.knownBy);
    expect(await K.debrief(s, cfg, 3)).toBe(1); // Bo is away
    expect(s.announcements.map((e: any) => [e.kind, e.to])).toEqual([["debrief", "u1"]]);
    expect(s.announcements[0].text).toContain("what did you gather");
    expect(s.announcements[0].text).toContain("Ada whispers to Bix");
    expect(s.pendingEvents[0].round).toBe(3);
    expect(s.pendingEvents[0].text).toContain("never announced");
    expect(JSON.stringify(f.knownBy)).toBe(known);
    expect(s.room.debrief).toEqual({ seen: [], npc: [] });
    expect(await K.debrief(s, cfg, 4)).toBe(0); // nothing waiting
  });
  it("does nothing without the setting or a room", async () => {
    expect(await K.debrief({ snapshots: [] } as any, cfg, 1)).toBe(0);
    expect(await K.debrief(setup().s, { ...cfg, debrief: null }, 1)).toBe(0);
  });
});

describe("the fair baseline: the server rolls the traits", () => {
  it("rolls each NPC's two traits once, uniformly, and locks them; real players and the table are left alone", () => {
    expect(cfg.overhear!.traits).toBe("roll");
    const st = state(); st.actors.npc_a.nosiness = 0; st.actors.table = { name: "Table" };
    let x = 0.1; const rng = (): number => (x = (x + 0.17) % 1);
    const n = K.rollTraits(st, cfg, rng);
    expect(n).toBe(8); // four NPCs, two fields
    for (const id of ["npc_a", "npc_b", "npc_c", "npc_d"]) for (const f of ["nosiness", "respects_privacy"]) { expect(st.actors[id][f]).toBeGreaterThan(0); expect(st.actors[id][f]).toBeLessThanOrEqual(1); expect(st.game.locked[`${id}.${f}`]).toBe(true); }
    expect(st.actors.user.nosiness).toBeUndefined();
    expect(st.actors.table.nosiness).toBeUndefined();
    const again = JSON.stringify(st.actors);
    expect(K.rollTraits(st, cfg, () => 0.5)).toBe(0); // once only
    expect(JSON.stringify(st.actors)).toBe(again);
  });
  it("keeps a value the game already gave, still locks it, skips exited NPCs, and none turns it off", () => {
    const st = state(); st.actors.npc_a.nosiness = 0.9; st.game.exited_game = [{ id: "npc_d" }];
    K.rollTraits(st, cfg, () => 0.5);
    expect(st.actors.npc_a.nosiness).toBe(0.9);
    expect(st.game.locked["npc_a.nosiness"]).toBe(true);
    expect(st.actors.npc_d.nosiness).toBe(0);
    const off = state();
    expect(K.rollTraits(off, { ...cfg, overhear: { ...cfg.overhear!, traits: "none" } }, () => 0.5)).toBe(0);
    expect(K.rollTraits(off, { ...cfg, overhear: null }, () => 0.5)).toBe(0);
  });
});
