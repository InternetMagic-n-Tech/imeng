import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCase, parseCheck } from "../src/utils/case-file.js";
import { runChecks } from "../src/utils/case-checks.js";

const FIX = path.join(process.cwd(), "tests/fixtures/cases/game/cases/one-shot.md");

describe("parseCase", () => {
  it("reads the header, steps (speaker and quotes optional) and expectations", () => {
    const c = parseCase(FIX);
    expect(c.name).toBe("all in then leave");
    expect(c.game).toBe(path.join(process.cwd(), "tests/fixtures/cases/game"));
    expect(c.state).toEqual({ actors: { user: { name: "Gus", chips: 200 } } });
    expect(c.private).toEqual(["I trust the house to settle me up"]);
    expect(c.steps).toEqual([{ who: "Gus", text: "Omaha. All in on the first hand, I have to go mow the lawn." }, { text: "bye" }]);
    expect(c.checks.map((k) => k.kind)).toEqual(["state", "state", "text", "text", "text", "judge"]);
    expect(c.chat).toBe("case-one-shot-md");
  });
  it("takes files for state, history and private, links shared parts, and lets flags win", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "case-"));
    fs.writeFileSync(path.join(d, "s.yaml"), "a: 1\n"); fs.writeFileSync(path.join(d, "h.json"), '[{"role":"user","content":"hi"}]'); fs.writeFileSync(path.join(d, "p.yaml"), "- note\n");
    fs.writeFileSync(path.join(d, "steps.md"), "1. one\n2. two\n");
    fs.writeFileSync(path.join(d, "c.md"), "---\ngame: .\nstate: s.yaml\nhistory: h.json\nprivate: p.yaml\nchat: mine\n---\n## Steps\n\n[parts](steps.md)\n");
    expect(() => parseCase(path.join(d, "c.md"))).not.toThrow();
    fs.writeFileSync(path.join(d, "c.md"), "---\ngame: .\nstate: s.yaml\nhistory: h.json\nprivate: p.yaml\nchat: mine\n---\n## Steps\n1. go\n");
    const c = parseCase(path.join(d, "c.md"));
    expect(c).toMatchObject({ state: { a: 1 }, history: [{ role: "user", content: "hi" }], private: ["note"], chat: "mine" });
    const o = parseCase(path.join(d, "c.md"), { state: '{"b": 2}', history: "[]", private: "[x]", chat: "other", game: "/tmp/g" });
    expect(o).toMatchObject({ state: { b: 2 }, history: [], private: ["x"], chat: "other", game: "/tmp/g" });
    expect(() => parseCase(path.join(d, "c.md"), { state: "nofile.json" })).toThrow(/file not found/);
  });
  it("rejects a case with no game or no steps", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "case-"));
    fs.writeFileSync(path.join(d, "a.md"), "---\nname: x\n---\n## Steps\n1. go\n"); expect(() => parseCase(path.join(d, "a.md"))).toThrow(/needs a game/);
    fs.writeFileSync(path.join(d, "b.md"), "---\ngame: .\n---\n# nothing\n"); expect(() => parseCase(path.join(d, "b.md"))).toThrow(/no steps/);
  });
});

describe("parseCheck and runChecks", () => {
  it("parses every kind and rejects the rest", () => {
    expect(parseCheck('state: a.b >= 5')).toMatchObject({ kind: "state", path: "a.b", op: ">=", value: 5 });
    expect(parseCheck('state: a.b present')).toMatchObject({ op: "present" });
    expect(parseCheck('text: last not contains "x"')).toMatchObject({ kind: "text", scope: "last", op: "not contains", value: "x" });
    expect(() => parseCheck("mood: sad")).toThrow(/unknown expectation/);
    expect(() => parseCheck("text: loves x")).toThrow(/contains/);
    expect(() => parseCheck("state: justapath")).toThrow(/<path> <op> <value>/);
  });
  it("checks state values and reply text, leaving judge lines undecided", () => {
    const state = { actors: { user: { chips: 150, tags: ["leaver", "ok"], name: "Gus" } }, game: { phase: "play" } };
    const lines = ['state: actors.user.chips > 100', 'state: actors.user.chips <= 100', 'state: actors.user.tags contains leaver', 'state: actors.user.name == "Gus"', 'state: game.phase != "play"', 'state: game.nope present', 'state: actors.user.name contains us',
      'text: contains "SETTLE"', 'text: not contains "borrow"', 'text: last matches /^bye/i', 'text: last contains hello', 'text: matches /(settle|later)/', 'judge: ok'];
    const out = runChecks(lines.map(parseCheck), state, ["We will settle up", "bye now"]);
    expect(out.map((o) => (o ? o.ok : null))).toEqual([true, false, true, true, false, false, true, true, true, true, false, true, null]);
    expect(runChecks([parseCheck("state: x > 1")], { x: "abc" }, [])[0]!.ok).toBe(false);
  });
});
