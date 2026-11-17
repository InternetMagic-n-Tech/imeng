import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/forfeit");
const { FORFEIT } = await import("../src/utils/config.js");
const { rollForfeit, answerForfeit, hasImage } = await import("../src/utils/forfeit.js");

const st = (): any => ({ game: { phase: "playing", events: [], exited_game: [] }, actors: {
  user: { name: "Bea", controlled_by: "user", stain: 0, ground_rules: [] },
  p_bo: { name: "Bo", controlled_by: "other_player", stain: 0, ground_rules: ["no photos"] },
  npc_cy: { name: "Cy", controlled_by: "npc", stain: 0, ground_rules: [] },
} });
const hit = (): number => 0, miss = (): number => 0.99;
const sess = (): any => ({});

describe("forfeit: a picture owed, dealt and checked by code", () => {
  it("is read from config.json", () => {
    expect(FORFEIT).toMatchObject({ chance: 0.5, rounds: 2, penalty: { field: "stain", add: 1 } });
  });
  it("a roll that misses does nothing; a hit picks only a real player without ground rules, never an NPC", () => {
    const s = sess();
    expect(rollForfeit(s, st(), 3, miss).game.forfeit).toBeUndefined();
    const out = rollForfeit(s, st(), 3, hit);
    expect(out.game.forfeit).toEqual({ actor: "user", left: 2 });
    expect(s.pendingEvents).toEqual([{ round: 3, text: "Bea owes a picture." }]);
  });
  it("nobody eligible, nothing is dealt", () => {
    const x = st(); x.actors.user.ground_rules = ["no"];
    expect(rollForfeit(sess(), x, 1, hit).game.forfeit).toBeUndefined();
  });
  it("an exited player is not picked", () => {
    const x = st(); x.game.exited_game = [{ id: "user" }];
    expect(rollForfeit(sess(), x, 1, hit).game.forfeit).toBeUndefined();
  });
  it("counts down, and a miss applies the penalty once and says so", () => {
    const s = sess();
    let x: any = rollForfeit(s, st(), 1, hit);
    x = rollForfeit(s, x, 2, hit);
    expect(x.game.forfeit).toEqual({ actor: "user", left: 1 });
    x = rollForfeit(s, x, 3, miss);
    expect(x.game.forfeit).toBeUndefined();
    expect(x.actors.user.stain).toBe(1);
    expect(s.pendingEvents.at(-1)).toEqual({ round: 3, text: "Bea missed." });
  });
  it("the right person sending a picture pays it; someone else's picture or none does not", () => {
    const x: any = rollForfeit(sess(), st(), 1, hit);
    expect(answerForfeit(x, "npc_cy")).toBe("");
    expect(x.game.forfeit).toBeTruthy();
    expect(answerForfeit(x, "user")).toBe("Bea paid.");
    expect(x.game.forfeit).toBeUndefined();
    expect(answerForfeit(x, "user")).toBe("");
  });
  it("hasImage sees an image part or a kept placeholder, and plain text is not one", () => {
    expect(hasImage([{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }])).toBe(true);
    expect(hasImage("here [image:abc123]")).toBe(true);
    expect(hasImage([{ type: "text", text: "[image:abc_1]" }])).toBe(true);
    expect(hasImage("just words")).toBe(false);
    expect(hasImage(undefined)).toBe(false);
  });
});
