import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSettings } from "../src/utils/doctor-settings.js";

describe("buildSettings", () => {
  it("describes the configured game for the doctor", () => {
    const s = buildSettings();
    expect(s).toMatchObject({
      upstream: "http://localhost:11434/v1", model: "gemma4:26b", judgeModel: "judge-model", judgeUrl: "", judgeInstance: null,
      invocation: "judge", dice: true, port: 3001, redisUrl: "", promptFileFound: true, judgeNumCtx: 8192,
    });
    expect(s.gameDir).toBe(process.env.IMENG_PATH);
    expect(s.systemPrompt).toContain('If the user\'s first message is "Game: Test Adventure"');
    expect(s.game.model_id).toBe("test-game");
  });

  it("builds the per-turn prompt the narrator really receives (prompt + state + dice)", () => {
    const text = buildSettings().fixedPromptText;
    expect(text).toContain("You are the narrator of a test game.");
    expect(text).toContain("CURRENT GAME STATE");
    expect(text).toContain("SESSION RULES IN EFFECT");
    expect(text).toContain("## DICE");
  });

  it("reads engines.node from package.json, and tolerates a missing file", () => {
    expect(buildSettings().nodeEngines).toBe(">=22.9.0 <23");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
    const f = path.join(dir, "package.json");
    fs.writeFileSync(f, '{"engines":{"node":">=20"}}');
    expect(buildSettings(f).nodeEngines).toBe(">=20");
    expect(buildSettings(path.join(dir, "nope.json")).nodeEngines).toBeUndefined();
    fs.writeFileSync(f, "{ broken");
    expect(buildSettings(f).nodeEngines).toBeUndefined();
  });
});
