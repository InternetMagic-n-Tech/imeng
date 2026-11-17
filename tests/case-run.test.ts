import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";

const GAME = path.join(process.cwd(), "tests/fixtures/cases/game");
process.env.IMENG_PATH = GAME;
const { parseCase } = await import("../src/utils/case-file.js");
const { runCase } = await import("../src/utils/case-run.js");
const { sessions } = await import("../src/utils/sessions.js");
const ollama = makeOllama();

beforeEach(() => {
  ollama.reset(); ollama.s.invoke = { invoked: true, reason: "plays" }; ollama.s.setup = { rules: [], actors: [] }; sessions.clear();
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
const file = path.join(GAME, "cases/one-shot.md");

describe("runCase", () => {
  it("seeds the state, sends private notes then steps, checks state, text and the judge", async () => {
    ollama.s.narrations.push("The dealer nods.", "Bye, the house will settle later.");
    ollama.s.caseJudges.push({ ok: true, why: "he left freely" });
    const lines: string[] = [];
    const r = await runCase(parseCase(file), { log: (l) => lines.push(l) });
    expect(r.passed).toBe(true);
    expect(r.steps.map((s) => s.reply)).toEqual(["The dealer nods.", "Bye, the house will settle later."]);
    expect(r.outcomes.every((o) => o.ok)).toBe(true);
    expect(lines.some((l) => /step 2\/2: 200 in \d+ms/.test(l))).toBe(true);
    expect(r.calls.some((c) => c.ok && c.system)).toBe(true);
    expect(r.prompt).toContain("dealer");
    const judge = ollama.calls("case_judge").at(-1)!.body.messages[1].content;
    expect(judge).toContain("friendly card table");
    expect(judge).toContain("CLAIM TO CHECK: the dealer lets the player leave");
  });
  it("a failed expectation fails the case and a judge verdict of no is recorded", async () => {
    ollama.s.narrations.push("Fine.", "Later.");
    ollama.s.caseJudges.push({ ok: false, why: "he was kept at the table" });
    const r = await runCase(parseCase(file), { judgeModel: "big-judge", log: () => {} });
    expect(r.passed).toBe(false);
    expect(r.outcomes.filter((o) => !o.ok).map((o) => o.line)).toEqual(expect.arrayContaining(["text: contains \"dealer\"", "judge: the dealer lets the player leave"]));
    expect(ollama.calls("case_judge").at(-1)!.body.model).toBe("big-judge");
  });
  it("a request that fails is reported, not thrown, and the judge is not asked", async () => {
    ollama.s.narratorThrows = true;
    const r = await runCase(parseCase(file), { log: () => {} });
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/failed|step/);
    expect(r.calls.some((c) => !c.ok)).toBe(true);
    expect(r.outcomes.at(-1)!.detail).toMatch(/not judged/);
    expect(ollama.calls("case_judge")).toHaveLength(0);
  });
  it("a judge that cannot be reached is a failed check, and history seeds matching snapshots", async () => {
    const c = parseCase(file, { history: JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]) });
    c.chat = "hist";
    ollama.s.narrations.push("The dealer nods.", "bye");
    ollama.s.judgeDown = true;
    const r = await runCase(c, { log: () => {} });
    expect(r.outcomes.at(-1)!.detail).toMatch(/judge failed/);
    expect(sessions.get("chat:hist")!.snapshots.length).toBeGreaterThanOrEqual(2);
  });
});
