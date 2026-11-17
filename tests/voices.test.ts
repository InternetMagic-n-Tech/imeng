import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/voices");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const go = async (id: string) => {
  ollama.s.narration = "ok"; ollama.s.extractor.push([]);
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content: "hello everyone" }] });
  await sessions.get("chat:" + id)!.tail;
  return JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
};

describe("per-character voices", () => {
  it("hands the narrator each NPC's own line, and none for the user", async () => {
    ollama.s.voices = { Bo: "Oh, I am SO ready." };
    const p = await go("v1");
    expect(p).toContain("WHAT EACH CHARACTER SAYS NEXT");
    expect(p).toContain("Bo: Oh, I am SO ready.");
    expect(p).not.toContain("Bea: ");
    expect(ollama.calls("voice").length).toBe(1);
  });
  it("leaves the character to the narrator when the call fails", async () => {
    ollama.s.judgeDown = true;
    const p = await go("v2");
    expect(p).not.toContain("WHAT EACH CHARACTER SAYS NEXT");
  });
});

describe("an NPC hints at its feelings (never a number)", () => {
  it("is drawn to someone at 2 or 3 and cannot stand someone at -1; says nothing about 0 or 1", async () => {
    const { feelingsFor } = await import("../src/utils/voices.js");
    const st: any = { game: { attraction: { npc_a: { user: 2, npc_b: -1, npc_c: 1, npc_d: 0 } } }, actors: { user: { name: "Gus" }, npc_a: { name: "Bea" }, npc_b: { name: "Bix" }, npc_c: { name: "Cy" }, npc_d: { name: "Dot" } } };
    const f = feelingsFor(st, "npc_a");
    expect(f).toContain("Bea is drawn to Gus");
    expect(f).toContain("Bea cannot stand Bix");
    expect(f).not.toContain("Cy");
    expect(f).not.toContain("Dot");
    expect(f).not.toMatch(/\d/);
    expect(feelingsFor({ game: {}, actors: {} } as any, "npc_a")).toBe("");
  });
});
