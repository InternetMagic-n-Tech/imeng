import { describe, it, expect } from "@jest/globals";
import { runDoctor } from "../src/utils/doctor.js";
import { makeSettings, makeSys } from "./fake-sys.js";

const run = async (game: Record<string, unknown>) => (await runDoctor(makeSys({}), makeSettings({ game: game as never }))).findings.filter((x) => /^(link|freeze)-/.test(x.id));
const level = (fs: { id: string; level: string }[], id: string) => fs.find((x) => x.id === id)?.level;

describe("doctor: link and freeze", () => {
  it("says nothing without the blocks", async () => { expect(await run({})).toEqual([]); });
  it("accepts good blocks", async () => {
    const f = await run({ link: { style: "chars" }, freeze: { mode: "npc", catch_up: "public" } });
    expect(level(f, "link-config")).toBe("ok");
    expect(level(f, "freeze-config")).toBe("ok");
    expect(level(f, "freeze-solo")).toBe("info");
  });
  it("fails a bad word list", async () => {
    const words = ["a-b", "c", "c"];
    const f = await run({ link: { style: "words", words } });
    expect(level(f, "link-config")).toBe("fail");
    expect(f.find((x) => x.id === "link-config")!.detail).toMatch(/at least 16.*hyphens.*duplicates/);
  });
});

describe("doctor: judge_api openai", () => {
  it("probes /v1/models instead of Ollama's API", async () => {
    const mk = async (routes: Record<string, { ok: boolean; status: number }>) => {
      const sys = makeSys({ routes });
      return (await runDoctor(sys, makeSettings({ judgeApi: "openai", judgeUrl: "http://127.0.0.1:8081" } as never))).findings.filter((x) => x.id.startsWith("judge-"));
    };
    expect(level(await mk({ "GET http://127.0.0.1:8081/v1/models": { ok: true, status: 200 } }), "judge-reachable")).toBe("ok");
    expect(level(await mk({}), "judge-reachable")).toBe("fail");
  });
});

describe("doctor: wrap_up.credits_file", () => {
  const run2 = async (credits: string, files: Record<string, string> = {}) => (await runDoctor(makeSys({ files }), makeSettings({ game: { wrap_up: { at_turn: 5, credits_file: credits } } as never }))).findings.find((x) => x.id === "game-config");
  it("reports a missing, empty or outside file", async () => {
    expect((await run2("CREDITS.md"))?.detail).toMatch(/was not found/);
    expect((await run2("CREDITS.md", { "/game/CREDITS.md": " " }))?.detail).toMatch(/is empty/);
    expect((await run2("../x.md"))?.detail).toMatch(/inside the game folder/);
    expect((await run2("CREDITS.md", { "/game/CREDITS.md": "ok" }))?.level).toBe("ok");
  });
});

describe("doctor: tools.stock.calendar_file", () => {
  const run3 = async (files: Record<string, string>) => (await runDoctor(makeSys({ files }), makeSettings({ game: { tools: { stock: { calendar_file: "calendar.json" } } } as never }))).findings.find((x) => x.id === "game-config");
  it("reports a missing or broken calendar file", async () => {
    expect((await run3({}))?.detail).toMatch(/was not found/);
    expect((await run3({ "/game/calendar.json": "{" }))?.detail).toMatch(/not valid JSON/);
    expect((await run3({ "/game/calendar.json": '{"events":[]}' }))?.level).toBe("ok");
  });
});

describe("doctor: field_evidence", () => {
  it("rejects a pattern that is not a regular expression", async () => {
    const f = async (tpl: string) => (await runDoctor(makeSys({}), makeSettings({ game: { field_evidence: { score: tpl } } as never }))).findings.find((x) => x.id === "game-config");
    expect((await f("point to {name}"))?.level).toBe("ok");
    expect((await f("point ("))?.detail).toMatch(/field_evidence.score/);
  });
});
