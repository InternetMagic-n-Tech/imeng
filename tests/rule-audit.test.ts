import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/audit");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => {
  ollama.reset();
  ollama.s.narration = "Now everybody jump up and down!";
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const u = (c: string) => ({ role: "user", content: c });
const a = (c: string) => ({ role: "assistant", content: c });
const send = async (id: string, messages: object[]) => {
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
  return ollama.calls("narrator").at(-1)!.body.messages[0].content as string;
};
const hit = { id: "no_jumping", quote: "everybody jump up and down", reason: "asks everyone to jump" };

describe("rule enforcement (judge audits each reply)", () => {
  it("feeds a verified violation back to the narrator once, on the next turn", async () => {
    ollama.s.audits.push({ violations: [hit] });
    await send("a1", [u("one")]);
    expect(ollama.calls("rule_audit")).toHaveLength(1);
    expect(sessions.get("chat:a1")!.violations).toMatchObject({ turn: 1 });
    const next = await send("a1", [u("one"), a("x"), u("two")]);
    expect(next).toContain("RULE VIOLATION");
    expect(next).toContain("Nobody is asked to jump.");
    expect(next).toContain("everybody jump up and down");
    const after = await send("a1", [u("one"), a("x"), u("two"), a("y"), u("three")]); // clean audit: shown only once
    expect(after).not.toContain("RULE VIOLATION");
  });

  it("drops an accusation the second look does not confirm", async () => {
    ollama.s.audits.push({ violations: [hit] });
    ollama.s.confirms.push({ confirmed: false });
    await send("ac", [u("one")]);
    expect(ollama.calls("rule_confirm")).toHaveLength(1);
    expect(sessions.get("chat:ac")!.violations).toBeUndefined();
  });

  it("drops a confirmation that cites a rule that does not exist, or says the rule does not forbid it", async () => {
    ollama.s.audits.push({ violations: [hit] }, { violations: [hit] });
    ollama.s.confirms.push({ confirmed: true, rule_forbids_it: true, their_rule: "a rule nobody ever wrote" }, { confirmed: true, rule_forbids_it: false, their_rule: "Nobody is asked to jump." });
    await send("ax", [u("one")]);
    expect(sessions.get("chat:ax")!.violations).toBeUndefined();
    await send("ay", [u("one")]);
    expect(sessions.get("chat:ay")!.violations).toBeUndefined();
  });

  it("drops accusations whose quote is not in the narration, or whose rule does not exist", async () => {
    ollama.s.audits.push({ violations: [
      { id: "no_jumping", quote: "something the narrator never wrote", reason: "x" },
      { id: "made_up", quote: "jump up and down", reason: "x" },
      { id: "no_jumping", quote: "ab", reason: "too short" },
    ] });
    await send("a2", [u("one")]);
    expect(sessions.get("chat:a2")!.violations).toBeUndefined();
  });

  it("does not carry a violation into a regenerated turn", async () => {
    ollama.s.audits.push({ violations: [hit] });
    await send("a3", [u("one")]);
    const regen = await send("a3", [u("one")]); // same turn again: the earlier reply was replaced
    expect(regen).not.toContain("RULE VIOLATION");
  });

  it("survives a judge that is down or answers garbage", async () => {
    ollama.s.judgeDown = true;
    await send("a4", [u("one")]);
    expect(sessions.get("chat:a4")!.violations).toBeUndefined();
    ollama.reset();
    ollama.s.audits.push({ nope: true });
    await send("a5", [u("one")]);
    expect(sessions.get("chat:a5")!.violations).toBeUndefined();
  });
});
