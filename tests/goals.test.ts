import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/goals");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { (await import("node:fs")).mkdirSync(process.env.SAVE_DIR!, { recursive: true }); ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

type Msg = { role: string; content: string };
const post = (id: string, messages: Msg[]) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
const say = async (id: string, messages: Msg[], narration = "The Host grins.") => {
  ollama.s.narration = narration;
  const r = await post(id, messages);
  await sessions.get("chat:" + id)?.tail;
  return r;
};
const text = (r: request.Response): string => JSON.parse(r.text).choices[0].message.content;
const chat = (...lines: string[]): Msg[] => lines.flatMap((l, i) => (i < lines.length - 1 ? [{ role: "user", content: l }, { role: "assistant", content: "The Host grins." }] : [{ role: "user", content: l }]));
const session = (id: string) => sessions.get("chat:" + id)!;
const snap = (id: string) => session(id).snapshots.at(-1)!;

describe("goals: writing them down", () => {
  it("/goal writes one in the notebook, as a note that starts no round", async () => {
    await say("g1", chat("hello"));
    const r = await say("g1", [...chat("hello"), { role: "assistant", content: "The Host grins." }, { role: "user", content: "/goal get covered in pink gak" }]);
    expect(text(r)).toContain("Written in the Notebook: get covered in pink gak");
    expect(ollama.calls("narrator").length).toBe(1); // the command called no narrator
    expect(session("g1").goals!.goals[0]).toMatchObject({ actor: "user", text: "get covered in pink gak", source: "player" });
    expect(snap("g1").actors.user.goals_set).toBe(1);
  });
  it("stops at the maximum, and says what is empty", async () => {
    await say("g2", chat("hello"));
    const m = (t: string): Msg[] => [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: t }];
    await say("g2", m("/goal one"));
    await say("g2", m("/goal two"));
    expect(text(await say("g2", m("/goal three")))).toContain("already holds 2 goal(s)");
    expect(text(await say("g2", m("/goal")))).toContain("Write what you want");
    expect(session("g2").goals!.goals.length).toBe(2);
  });
  it("/goals lists them, with who got what only after the game", async () => {
    await say("g3", chat("hello"));
    const m = (t: string): Msg[] => [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: t }];
    await say("g3", m("/goal talk about my tattoo"));
    const t = text(await say("g3", m("/goals")));
    expect(t).toContain("In the Notebook:");
    expect(t).toContain("talk about my tattoo (not yet)");
    expect(t).not.toContain("Goals done:");
    expect(text(await say("g3", m("/goals")))).not.toContain("Bo");
  });
  it("refuses new goals outside the capture phase", async () => {
    await say("g4", chat("hello"));
    session("g4").snapshots.at(-1)!.game.phase = "playing";
    const r = await say("g4", [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "/goal win" }]);
    expect(text(r)).toContain("not the time for new goals");
  });
});

describe("goals: the narrator and the state", () => {
  it("tells the narrator only the NPC's goals (host: own), never a person's, and hides nothing the state needs", async () => {
    await say("n1", chat("hello"));
    const m = [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "/goal pink gak" }];
    await say("n1", m);
    ollama.s.goalInvents.push({ goal: "win the buzzer round" });
    await say("n1", chat("one", "two"));
    const prompt = JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
    expect(prompt).not.toContain("pink gak");
    expect(prompt).toContain("goals_set");
    await say("n1", chat("one", "two", "three"));
    const p3 = JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
    expect(p3).toContain("Bo secretly wants: win the buzzer round");
    expect(p3).not.toContain("pink gak");
  });
  it("invents an NPC's goal after the first round, once", async () => {
    ollama.s.goalInvents.push({ goal: "win the buzzer round" });
    await say("i1", chat("hello"));
    await say("i1", chat("hello", "again"));
    expect(session("i1").goals!.goals.filter((g) => g.actor === "npc_bo")).toHaveLength(1);
    expect(ollama.calls("goal_invent")).toHaveLength(1);
  });
});

describe("goals: reached in a round", () => {
  const setup = async (id: string) => {
    await say(id, chat("hello"));
    await say(id, [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "/goal get covered in pink gak" }]);
  };
  it("is accepted only with a quote that is in the round, then reacts, scores, and opens the next phase", async () => {
    await setup("r1");
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "words that nobody said" }] });
    await say("r1", chat("a", "b"), "Pink gak lands on Bea.");
    expect(session("r1").goals!.goals[0].done).toBeUndefined();
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "Pink gak lands on Bea" }] });
    await say("r1", chat("a", "b", "c"), "Pink gak lands on Bea. She cheers.");
    const g = session("r1").goals!.goals.find((x) => x.actor === "user")!;
    expect(g.done?.quote).toBe("Pink gak lands on Bea");
    expect(snap("r1").actors.user.goals_done).toBe(1);
    expect(snap("r1").actors.user.score).toBe(2);
    expect((snap("r1").game.calc as any).leader).toBe("user");
    await say("r1", chat("a", "b", "c", "d"));
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).toContain("Bea has just got what they secretly wanted");
  });
  it("does not call the judge when nothing is open, and survives a judge that is down", async () => {
    await say("r2", chat("hello"));
    expect(ollama.calls("goal_mark")).toHaveLength(0);
    await say("r2", [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "/goal win" }]);
    ollama.s.judgeDown = true;
    const r = await say("r2", chat("a", "b"));
    expect(r.status).toBe(200);
    expect(session("r2").goals!.goals[0].done).toBeUndefined();
  });
  it("forgets a goal reached on a round that is played again", async () => {
    await setup("r3");
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "Pink gak lands" }] });
    await say("r3", chat("a", "b"), "Pink gak lands on Bea.");
    expect(session("r3").goals!.goals[0].done).toBeDefined();
    await say("r3", chat("a", "b2"), "Nothing happens.");
    expect(session("r3").goals!.goals[0].done).toBeUndefined();
    expect(snap("r3").actors.user.goals_done).toBe(0);
  });
});

describe("goals: after the finale", () => {
  it("tells what everyone secretly wanted once, in code, and /goals then shows the standings", async () => {
    await setup2("f1");
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "Pink gak lands" }] });
    await say("f1", chat("a", "b", "c"), "Pink gak lands on Bea.");
    await say("f1", chat("a", "b", "c", "d"));
    await say("f1", chat("a", "b", "c", "d", "e")); // the finale
    const over = await say("f1", chat("a", "b", "c", "d", "e", "f"));
    const t = text(over);
    expect(t).toContain("What everyone secretly wanted:");
    expect(t).toContain("Bea: get covered in pink gak (done)");
    expect(t).toContain("Most goals: Bea.");
    expect(t).toContain("The show is over.");
    expect(text(await say("f1", chat("a", "b", "c", "d", "e", "f", "g")))).toBe("The show is over.");
    const list = text(await say("f1", [...chat("a", "b", "c", "d", "e", "f", "g"), { role: "assistant", content: "x" }, { role: "user", content: "/goals" }]));
    expect(list).toContain("Goals done:");
  });
  async function setup2(id: string) {
    await say(id, chat("hello"));
    await say(id, [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "/goal get covered in pink gak" }]);
    await say(id, chat("a", "b"));
  }
});

describe("goals: in the private channel, with a reason", () => {
  const prompt = (): string => JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
  it("a private-only note is read as a goal and a reason, starts no round, and is not shown to the narrator", async () => {
    await say("c1", chat("hello"));
    ollama.s.goalReads.push({ goal: "get covered in a colour I can see", reason: "I am red-green colour blind" });
    const note = "<private>I want to be covered in a gak colour I can actually see, I am red-green colour blind</private>";
    const r = await say("c1", [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: note }]);
    expect(text(r)).toContain("Written in the Notebook: get covered in a colour I can see");
    expect(ollama.calls("narrator")).toHaveLength(1);
    expect(session("c1").goals!.goals[0]).toMatchObject({ actor: "user", reason: "I am red-green colour blind" });
    await say("c1", [{ role: "user", content: "hello" }, { role: "assistant", content: "The Host grins." }, { role: "user", content: note }, { role: "assistant", content: text(r) }, { role: "user", content: "I pick trivia" }]);
    expect(prompt()).not.toContain("colour I can actually see"); // the note itself never reaches the narrator
    expect(prompt()).toContain("PRIVATE REASONS");
    expect(prompt()).toContain('Bea said, privately, about wanting \\"get covered in a colour I can see\\": I am red-green colour blind');
  });
  it("a public statement with a private reason is a goal with a reason; the round goes on and the reason is not echoed as a private line", async () => {
    await say("c2", chat("hello"));
    ollama.s.goalReads.push({ goal: "not get any gak on me", reason: "a new tattoo that burns when gak touches it" });
    const msg = "I do not want to get any gak <private>because I have a new tattoo that burns when gak gets on it</private>";
    await say("c2", [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: msg }]);
    expect(ollama.calls("goal_read").at(-1)!.body.messages[1].content).toContain("PUBLIC: I do not want to get any gak");
    expect(session("c2").goals!.goals[0]).toMatchObject({ text: "not get any gak on me", reason: "a new tattoo that burns when gak touches it" });
    expect(prompt()).toContain("I do not want to get any gak");
    expect(prompt()).not.toContain("PRIVATE (the player's own");
    expect(prompt()).toContain("a new tattoo that burns");
  });
  it("a private part that is not a goal still reaches the narrator as before", async () => {
    await say("c3", chat("hello"));
    await say("c3", [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "I look around <private>I distrust Bo</private>" }]);
    expect(prompt()).toContain("I distrust Bo");
    expect((session("c3").goals?.goals ?? []).filter((g) => g.actor === "user")).toHaveLength(0);
  });
  it("/goal <text> because <reason> keeps the reason; the goal judge is given it, so a colour they can see can satisfy it", async () => {
    await say("c4", chat("hello"));
    expect(text(await say("c4", [...chat("hello"), { role: "assistant", content: "x" }, { role: "user", content: "/goal get covered in blue gak because I am colour blind" }]))).toContain("get covered in blue gak");
    expect(session("c4").goals!.goals[0].reason).toBe("I am colour blind");
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "blue gak lands" }] });
    await say("c4", chat("hello", "two"), "Blue gak lands on Bea.");
    expect(ollama.calls("goal_mark").at(-1)!.body.messages[1].content).toContain("because");
    expect(session("c4").goals!.goals.find((g) => g.actor === "user")!.done).toBeDefined();
  });
});
