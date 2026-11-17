import { describe, it, expect } from "@jest/globals";
import { parseCard, showdown } from "../src/tools/poker-eval.js";

describe("poker showdown on a seeded hand", () => {
  it("aces full of sevens beats two pair on that board", () => {
    const board = ["As", "Ad", "7c", "7d", "2h"];
    const r = showdown("holdem", board, [{ id: "vic", hole: ["Ac", "Kd"] }, { id: "gus", hole: ["Kc", "Qd"] }]);
    expect(r.find((x) => x.id === "vic")).toMatchObject({ winner: true, name: "full house" });
    expect(r.find((x) => x.id === "gus")?.winner).toBeFalsy();
    expect(board.map(parseCard)).toHaveLength(5);
  });
});
