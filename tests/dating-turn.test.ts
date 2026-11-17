import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/dating");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const round = async (id: string, said: string, narration: string, evidence: unknown[]) => {
  ollama.s.narration = narration; ollama.s.dating.push({ evidence });
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content: said }] });
  await sessions.get("chat:" + id)!.tail;
  return sessions.get("chat:" + id)!.snapshots.at(-1)!;
};

describe("the dating check after a round", () => {
  it("moves attraction one level on a quote that is really in the round", async () => {
    const st = await round("d1", "I love cats!", "Bo grins. 'I love cats too,' says Bo.", [{ from: "npc_bo", to: "user", kind: "interest", quote: "I love cats too" }]);
    expect((st.game.attraction as any).npc_bo.user).toBe(1);
  });
  it("drops a quote that is not in the round, and a Host-mood quote", async () => {
    const a = await round("d2", "hello", "Bo waves.", [{ from: "npc_bo", to: "user", kind: "passion", quote: "I adore skydiving" }]);
    expect(a.game.attraction).toBeUndefined();
    const b = await round("d3", "hello", "Bo is clearly smitten.", [{ from: "npc_bo", to: "user", kind: "physical", quote: "clearly smitten" }]);
    expect(b.game.attraction).toBeUndefined();
  });
  it("never shows anyone's feelings to the narrator", async () => {
    await round("d4", "I love cats!", "Bo: 'I love cats too.'", [{ from: "npc_bo", to: "user", kind: "interest", quote: "I love cats too" }]);
    await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", "d4").send({ messages: [{ role: "user", content: "I love cats!" }, { role: "assistant", content: "Bo: 'I love cats too.'" }, { role: "user", content: "next" }] });
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).not.toContain("attraction");
  });
});

describe("age is hidden from the narrator", () => {
  it("shows adult or minor, never the number", async () => {
    const { stateBlock, initialState } = await import("../src/utils/state.js");
    const st: any = initialState();
    st.actors.user.age = 71; st.actors.npc_bo.age = 15;
    const out = stateBlock(st);
    expect(out).toContain('"age_group": "adult"');
    expect(out).toContain('"age_group": "minor"');
    expect(out).not.toMatch(/"age":/);
    expect(out).not.toContain("71");
  });
});

describe("what a contestant overheard reaches the dating check (the Susan case)", () => {
  it("heardLines lists a fact someone other than its subject knows, as heard", async () => {
    const { heardLines } = await import("../src/utils/dating-turn.js");
    const st: any = { game: {}, actors: { user: { name: "Gus" }, npc_bo: { name: "Susan" } } };
    const people = [{ id: "user" }, { id: "npc_bo" }] as any;
    const s: any = { knowledge: { facts: [{ about: "npc_bo", knownBy: ["user"], text: "… love … guys … pink" }, { about: "npc_bo", knownBy: ["npc_bo"], text: "her own secret" }, { about: "ghost", knownBy: ["user"], text: "x" }] } };
    expect(heardLines(s, people, st)).toEqual(["Susan (heard by Gus): … love … guys … pink"]);
    expect(heardLines(undefined, people, st)).toEqual([]);
  });
  it("the judge is told what was overheard; acting on it takes her from repulsion to 1 in one gate, and a gak'ing alone moves nothing", async () => {
    const { datingRound } = await import("../src/utils/dating-turn.js");
    const mk = (): any => ({ game: { attraction: { npc_bo: { user: -1 } }, exited_game: [], events: [] }, actors: { user: { name: "Gus", controlled_by: "user", age: 30, relationship: "single" }, npc_bo: { name: "Susan", controlled_by: "npc", age: 30, relationship: "single" } } });
    const session: any = { knowledge: { facts: [{ about: "npc_bo", knownBy: ["user"], text: "… love … guys … pink" }] } };
    ollama.s.dating.push({ evidence: [] });
    const none = await datingRound({ session, after: mk(), said: "I take the gak on the chin", narration: "Gus is covered in green gak." });
    expect((none.game.attraction as any).npc_bo.user).toBe(-1);
    const call = ollama.calls("dating").at(-1)!.body;
    expect(JSON.stringify(call)).toContain("OVERHEARD");
    expect(JSON.stringify(call)).toContain("heard by Gus");
    ollama.s.dating.push({ evidence: [{ from: "npc_bo", to: "user", kind: "interest", quote: "give me the pink gak" }] });
    const up = await datingRound({ session, after: mk(), said: "This is for you Susan... give me the pink gak", narration: "Gus grins." });
    expect((up.game.attraction as any).npc_bo.user).toBe(1);
    ollama.s.dating.push({ evidence: [{ from: "npc_bo", to: "user", kind: "interest", quote: "give me the pink gak again" }] });
    const again = await datingRound({ session, after: { ...up, game: { ...up.game } } as any, said: "give me the pink gak again", narration: "More pink." });
    expect((again.game.attraction as any).npc_bo.user).toBe(1); // a shared taste is a gate, not an increment
  });
});

describe("checkEvidence copes with what a small judge writes", () => {
  it("accepts a name or a one-letter slip for an id, and turns an overheard pair round", async () => {
    const { checkEvidence } = await import("../src/utils/dating-turn.js");
    const ids = new Set(["user", "npc_susan"]), names = new Map([["gus", "user"], ["susan", "npc_susan"]]), text = "This is for you Susan... give me the pink gak!";
    const q = "give me the pink gak";
    expect(checkEvidence([{ from: "gust", to: "susan", kind: "interest", quote: q }], text, ids, names, new Set(["npc_susan>user"]))).toEqual([{ from: "npc_susan", to: "user", ev: { kind: "interest", quote: q } }]); // turned round: she warms toward him
    expect(checkEvidence([{ from: "npc_susan", to: "user", kind: "interest", quote: q }], text, ids, names, new Set(["npc_susan>user"]))).toHaveLength(1); // already right
    expect(checkEvidence([{ from: "gus", to: "susan", kind: "interest", quote: q }], text, ids, names)).toEqual([{ from: "user", to: "npc_susan", ev: { kind: "interest", quote: q } }]); // no overheard pair: left as written
    expect(checkEvidence([{ from: "zed", to: "susan", kind: "interest", quote: q }], text, ids, names)).toEqual([]); // unknown, not near any name
    expect(checkEvidence([{ from: "gus", to: "gus", kind: "interest", quote: q }], text, ids, names)).toEqual([]);
    expect(checkEvidence([{ from: "gus", to: "susan", kind: "interest", quote: "not in the round" }], text, ids, names)).toEqual([]);
    expect(checkEvidence([{ from: "gus", to: "susan", kind: "physical", quote: q }], text, ids, names, new Set(["npc_susan>user"]))[0].from).toBe("user"); // only a shared taste is turned round
  });
});
