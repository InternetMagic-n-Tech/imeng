import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/ruling");
const ollama = makeOllama();
const { listed } = await import("../src/utils/ruling.js");
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const go = async (id: string, text: string) => {
  ollama.s.narration = "ok"; ollama.s.extractor.push([]);
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content: text }] });
  await sessions.get("chat:" + id)!.tail;
  return JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
};

describe("the lookup table", () => {
  it("is code: listed spells pass, others do not, and a class without an entry is left to the judge", () => {
    const t = { wizard: ["Fireball"], fighter: [] as string[] };
    expect(listed(t, "Wizard", "fireball")).toBe(true);
    expect(listed(t, "wizard", "heal")).toBe(false);
    expect(listed(t, "fighter", "fireball")).toBe(false);
    expect(listed(t, "bard", "anything")).toBe(true);
    expect(listed(undefined, "x", "y")).toBe(true);
  });
});

describe("the magic ruling", () => {
  it("tells the narrator an allowed spell works", async () => {
    ollama.s.rulings.push({ spell: "fireball", allowed: true, reason: "" });
    const p = await go("r1", "I cast fireball at the goblins");
    expect(p).toContain("MAGIC RULING");
    expect(p).toContain("fireball: ALLOWED");
  });
  it("refuses a spell the class cannot cast even when the judge says yes", async () => {
    ollama.s.rulings.push({ spell: "heal", allowed: true, reason: "sure" });
    const p = await go("r2", "I cast heal on myself");
    expect(p).toContain("heal: NOT ALLOWED");
    expect(p).toContain("a wizard cannot cast heal");
  });
  it("gives no ruling when it is not a magic attempt or the judge is down", async () => {
    expect(await go("r3", "I open the door")).not.toContain("MAGIC RULING");
    ollama.s.judgeDown = true;
    expect(await go("r4", "I cast fireball")).not.toContain("MAGIC RULING");
  });
});

describe("a table's round", () => {
  it("rules on each public line, by name, and skips private ones", async () => {
    const { ruleRound } = await import("../src/utils/ruling.js");
    const st: any = { game: { phase: "playing" }, actors: { a: { class: "wizard", level: 1, inventory: [] }, b: { class: "wizard", level: 1, inventory: [] } } };
    ollama.s.rulings.push({ spell: "fireball", allowed: true, reason: "" }, { spell: "heal", allowed: true, reason: "" });
    const out = await ruleRound(st, "[Bea (actors.a)] I cast fireball\n[Bo (actors.b)] I cast heal\n[Cy (actors.c)] PRIVATE I cast sleep\nNOTE: x");
    expect(out).toContain("Bea: fireball: ALLOWED");
    expect(out).toContain("Bo: heal: NOT ALLOWED");
    expect(out).not.toContain("sleep");
  });
});
