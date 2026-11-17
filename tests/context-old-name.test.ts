import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/guard-old");

describe("history_limit (the v1.1 name)", () => {
  it("still sets the actor history cap, and the machine guards are off when the env is unset", async () => {
    const cfg = await import("../src/utils/config.js");
    expect(cfg.HISTORY_LIMIT).toBe(4);
    expect(cfg.CONTEXT_MAX_TOKENS).toBe(0);
    expect(cfg.CONTEXT_MAX_ROUNDS).toBe(0);
    expect(cfg.WRAP_UP).toBeNull();
  });
});
