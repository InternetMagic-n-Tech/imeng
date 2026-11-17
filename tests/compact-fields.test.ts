import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/compact-fields");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
let checkRecapFields: typeof import("../src/utils/compact.js").checkRecapFields;
let initialState: typeof import("../src/utils/state.js").initialState;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
  ({ checkRecapFields } = await import("../src/utils/compact.js"));
  ({ initialState } = await import("../src/utils/state.js"));
});
beforeEach(() => {
  ollama.reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const filler = (n: number) => `message ${n} ` + "words ".repeat(60);
/** A chat of `n` complete turns (user + assistant), then the next user message. */
const chat = (n: number, edit?: { turn: number; text: string }) => {
  const m: { role: string; content: string }[] = [];
  for (let i = 1; i <= n; i++) {
    m.push({ role: "user", content: edit?.turn === i ? edit.text : filler(i) });
    if (i < n) m.push({ role: "assistant", content: filler(100 + i) });
  }
  return m;
};
const send = async (id: string, messages: unknown[]) => {
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
};
const GOOD = "Joey opened the show and the studio audience cheered as the first contestant stepped up to the tank and took a splash of green gak.";

const ok = { people: [{ name: "Joey", out: false, fields: { warmth: 10 } }] };

describe("compaction verified against the record (verify: fields)", () => {
  it("accepts a recap that agrees with the record, and never asks the judge", async () => {
    ollama.s.recap.push(GOOD);
    ollama.s.extracts.push(ok);
    await send("f1", chat(5));
    expect(sessions.get("chat:f1")!.summary).toMatchObject({ upto: 3, text: GOOD });
    expect(ollama.calls("compaction_extract")).toHaveLength(1);
    expect(ollama.calls("compaction_judge")).toHaveLength(0);
    const call = ollama.calls("compaction_extract")[0].body;
    expect(call.reasoning_effort).toBe("none");
    expect(call.messages[1].content).toContain("<recap>");
  });

  it("rejects a recap whose numbers or exit claims disagree with the record, and retries with the problems", async () => {
    ollama.s.recap.push(GOOD, GOOD + " Joey shivered.");
    ollama.s.extracts.push({ people: [{ name: "Joey", out: true, fields: { warmth: 3 } }] }, ok);
    await send("f2", chat(5));
    const second = ollama.calls("compactor")[1].body.messages[1].content as string;
    expect(second).toContain("says Joey is out of the game, but they are not");
    expect(second).toContain("Joey's warmth is 10");
    expect(sessions.get("chat:f2")!.summary).toBeDefined();
  });

  it("keeps the full chat when the recap keeps disagreeing, or the reading is unusable", async () => {
    ollama.s.recap.push(GOOD, GOOD);
    ollama.s.extracts.push({ people: [{ name: "Joey", out: true, fields: {} }] }, { nope: 1 });
    await send("f3", chat(5));
    expect(sessions.get("chat:f3")!.summary).toBeUndefined();
    expect(sessions.get("chat:f3")!.compactHold).toBe(10);
  });
});

describe("a recap is written and checked against the record at the turn it ends at", () => {
  it("does not demand someone who only joined after the cutoff, and shows the compactor the older record", async () => {
    const { maybeCompact } = await import("../src/utils/compact.js");
    const old = initialState(); old.actors.user.name = "Joey";
    const now = initialState(); now.actors.user.name = "Joey"; now.actors.late = { ...now.actors.user, name: "Latecomer" };
    const session: any = { snapshots: [old, old, old, old, now], unsynced: [], tail: Promise.resolve() };
    ollama.s.recap.push(GOOD);
    ollama.s.extracts.push(ok);
    await maybeCompact(session, chat(5) as any, filler(9), now, 5);
    expect(session.summary).toMatchObject({ upto: 3, text: GOOD });
    expect(ollama.calls("compactor")[0].body.messages[1].content).not.toContain("Latecomer");
  });

  it("waits instead of re-folding every turn when the prompt is still over the line after a recap", async () => {
    const { maybeCompact } = await import("../src/utils/compact.js");
    const st = initialState(); st.actors.user.name = "Joey";
    const session: any = { snapshots: [st, st, st, st, st], unsynced: [], tail: Promise.resolve() };
    ollama.s.recap.push(GOOD);
    ollama.s.extracts.push(ok);
    await maybeCompact(session, chat(5) as any, filler(9), st, 5);
    expect(session.summary).toBeDefined();
    expect(session.compactHold).toBe(10); // 2 kept turns alone are already over 150 tokens
  });
});

describe("checkRecapFields", () => {
  const make = () => {
    const st = initialState();
    Object.assign(st.actors.user, { name: "Joey", statuses: ["green"], description: "tall" });
    return st;
  };
  it("compares numbers, strings and lists with the record, and accepts what matches or is not stated", async () => {
    ollama.s.extracts.push({ people: [{ name: "Joey", out: false, fields: { warmth: 10, statuses: ["Green"], description: "Tall", missing: null } }] });
    expect(await checkRecapFields("r", make(), ["warmth", "statuses", "description", "missing"])).toEqual([]);
  });
  it("reports mismatches in each kind of field and a person it could not read", async () => {
    ollama.s.extracts.push({ people: [{ name: "Joey", out: false, fields: { warmth: 3, statuses: ["green", "red"], description: "short" } }] });
    const p = (await checkRecapFields("r", make(), ["warmth", "statuses", "description"])).join(" | ");
    expect(p).toContain("warmth is 10");
    expect(p).toContain("does not include \"red\"");
    expect(p).toContain("description is \"tall\"");
    ollama.s.extracts.push({ people: [] });
    expect((await checkRecapFields("r", make(), [])).join()).toContain("nothing could be read about Joey");
  });
  it("needs someone with a name to check", async () => {
    const st = initialState(); // the initial user is called "you"... remove all names
    st.actors.user.name = "";
    expect(await checkRecapFields("r", st, [])).toEqual([]);
  });
});
