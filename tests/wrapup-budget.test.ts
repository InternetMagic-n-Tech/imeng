import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/guard-budget");

describe("wrap_up.turn_budget after_compaction", () => {
  it("counts rounds until a recap exists, then waits", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const { wrapUpStatus } = await import("../src/utils/wrapup.js");
    const { WRAP_UP } = await import("../src/utils/config.js");
    expect(WRAP_UP!.turn_budget).toBe("after_compaction");
    const state = { game: { exited_game: [] }, actors: {} } as any;
    const bare = () => ({} as any);
    expect(wrapUpStatus(bare(), 4, 10, [], state).text).toContain("WRAP UP (this is the final turn)");
    const compacted = { summary: { upto: 2, sig: "x", text: "recap" } } as any;
    expect(wrapUpStatus(compacted, 4, 10, [], state).text).toBe("");
    expect(compacted.wrapUp).toBeUndefined();
  });
});
