import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/compact");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
let checkRecap: typeof import("../src/utils/compact.js").checkRecap;
let initialState: typeof import("../src/utils/state.js").initialState;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
  ({ checkRecap } = await import("../src/utils/compact.js"));
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

describe("checkRecap", () => {
  const make = () => { const s = initialState(); s.actors.user.name = "Joey"; return s; };
  it("accepts a prose recap that names everyone", () => { const state = make(); expect(checkRecap(GOOD, state, 600)).toEqual([]); });
  it("counts a person as named by an alias field (how they asked to be addressed)", () => {
    const state = make();
    state.actors.user.name = "Marta";
    (state.actors.user as Record<string, unknown>).address_as = "Dr. Okafor";
    const recap = "Dr. Okafor opened the show and the studio audience cheered as the first contestant stepped up to the tank.";
    expect(checkRecap(recap, state, 600, ["address_as"])).toEqual([]);
    expect(checkRecap(recap, state, 600, []).join()).toContain("never names Marta");
    expect(checkRecap(recap, state, 600, ["missing_field"]).join()).toContain("never names Marta");
  });
  it("rejects empty, long, JSON-looking and name-dropping recaps", () => {
    const state = make();
    expect(checkRecap("short", state, 600).join()).toContain("too short");
    expect(checkRecap(GOOD + " x".repeat(400), state, 600).join()).toContain("longer than");
    expect(checkRecap('{"recap": "Joey did a thing and then another thing happened"}', state, 600).join()).toContain("JSON");
    expect(checkRecap("The audience cheered as somebody stepped up to the tank and took a splash of green gak.", state, 600).join()).toContain("never names Joey");
  });
});

describe("compaction", () => {
  it("does nothing while the chat is short", async () => {
    await send("c0", chat(2));
    expect(ollama.calls("compactor")).toHaveLength(0);
    expect(sessions.get("chat:c0")!.summary).toBeUndefined();
  });

  it("replaces old turns with a recap that passes the checks, and uses it on the next turn", async () => {
    ollama.s.recap.push(GOOD);
    await send("c1", chat(5));
    const s = sessions.get("chat:c1")!;
    expect(ollama.calls("compactor")).toHaveLength(1);
    expect(ollama.calls("compaction_judge")).toHaveLength(1);
    expect(s.summary).toMatchObject({ upto: 3, text: GOOD });
    // the judge was told the recap and the state, inside untrusted-data markers
    expect(ollama.calls("compaction_judge")[0].body.messages[1].content).toContain("<recap>");

    await send("c1", chat(6));
    const prompt = ollama.calls("narrator").at(-1)!.body.messages;
    expect(prompt[0].content).toContain("STORY SO FAR");
    expect(prompt[0].content).toContain(GOOD);
    const text = JSON.stringify(prompt.slice(1));
    expect(text).not.toContain("message 1 ");
    expect(text).not.toContain("message 3 ");
    expect(text).toContain("message 4 ");
    expect(text).toContain("message 6 ");
  });

  it("retries once with feedback when the judge says the recap invented something", async () => {
    ollama.s.recap.push(GOOD, GOOD + " Then Dot left.");
    ollama.s.recapVerdicts.push({ faithful: false, invented: ["Dot left"], missing: [] }, { faithful: true, invented: [], missing: [] });
    await send("c2", chat(5));
    const calls = ollama.calls("compactor");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.messages[1].content).toContain("invented: Dot left");
    expect(sessions.get("chat:c2")!.summary).toBeDefined();
  });

  it("keeps the full chat and backs off when the recap keeps failing", async () => {
    ollama.s.recap.push(GOOD, GOOD);
    ollama.s.recapVerdicts.push({ faithful: false, invented: [], missing: ["Marta"] }, { faithful: false, invented: [], missing: ["Marta"] });
    await send("c3", chat(5));
    const s = sessions.get("chat:c3")!;
    expect(s.summary).toBeUndefined();
    expect(s.compactHold).toBe(10);
    await send("c3", chat(6)); // within the hold: no new attempt
    expect(ollama.calls("compactor")).toHaveLength(2);
    expect(ollama.calls("narrator").at(-1)!.body.messages[0].content).not.toContain("STORY SO FAR");
  });

  it("does not ask the judge about a recap that fails the code check", async () => {
    ollama.s.recap.push("The audience cheered as somebody stepped up to the tank and took a splash of green gak.", GOOD);
    await send("c4", chat(5));
    expect(ollama.calls("compactor")).toHaveLength(2);
    expect(ollama.calls("compaction_judge")).toHaveLength(1);
    expect(ollama.calls("compactor")[1].body.messages[1].content).toContain("never names Joey");
  });

  it("skips compaction when the judge is unreachable", async () => {
    ollama.s.recap.push(GOOD);
    ollama.s.judgeDown = true;
    await send("c5", chat(5));
    expect(sessions.get("chat:c5")!.summary).toBeUndefined();
    expect(sessions.get("chat:c5")!.compactHold).toBe(10);
  });

  it("drops a recap when the player edits a turn it covers", async () => {
    ollama.s.recap.push(GOOD);
    await send("c6", chat(5));
    expect(sessions.get("chat:c6")!.summary).toBeDefined();
    await send("c6", chat(6, { turn: 2, text: "I changed my mind about this move" }));
    const prompt = ollama.calls("narrator").at(-1)!.body.messages;
    expect(prompt[0].content).not.toContain("STORY SO FAR");
    expect(JSON.stringify(prompt)).toContain("I changed my mind");
    expect(sessions.get("chat:c6")!.summary).toBeUndefined();
  });

  it("drops a recap when the player goes back before the covered turns", async () => {
    ollama.s.recap.push(GOOD);
    await send("c7", chat(5));
    await send("c7", chat(3));
    expect(ollama.calls("narrator").at(-1)!.body.messages[0].content).not.toContain("STORY SO FAR");
  });
});
