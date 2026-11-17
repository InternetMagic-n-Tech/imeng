import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { makeRenderer, PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/keepsake");
process.env.PUBLIC_URL = "https://game.example";
process.env.IMAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "keepsake-"));
const ollama = makeOllama();
let renderer: ReturnType<typeof makeRenderer>;
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { renderer = makeRenderer(); ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => {
  ollama.reset();
  renderer.s.calls.length = 0; renderer.s.output = PNG; renderer.s.delayMs = 0; renderer.s.status = 200; renderer.s.uploads = 0; renderer.s.pendingPolls = 0;
  for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});

type M = { role: string; content: string };
const u = (content: string): M => ({ role: "user", content });
const a = (content: string): M => ({ role: "assistant", content });
const say = async (id: string, messages: M[]): Promise<string> => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  if (r.status !== 200) throw new Error("status " + r.status + " " + r.text);
  await sessions.get("chat:" + id)?.tail;
  return r.body.choices[0].message.content;
};
const chat = (...lines: string[]): M[] => lines.flatMap((l, i) => (i < lines.length - 1 ? [u(l), a("x")] : [u(l)]));
const workflow = () => JSON.parse(JSON.stringify(renderer.s.calls.find((c) => c.path === "/prompt")!.body.prompt));

/** Plays to the end: Bea writes a goal, reaches it on round 2, the finale is round 3. */
async function finish(id: string): Promise<M[]> {
  await say(id, chat("hello"));
  await say(id, [...chat("hello"), a("x"), u("/goal wear pink gak")]);
  ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "pink gak lands" }] });
  ollama.s.narration = "Pink gak lands on Bea.";
  await say(id, chat("hello", "two"));
  await say(id, chat("hello", "two", "three"));
  return chat("hello", "two", "three", "four");
}

describe("pictures from state, refined", () => {
  it("gives the writer the listed state fields, moves negations out, and adds back a recorded colour the judges dropped", async () => {
    await say("p1", chat("hello"));
    ollama.s.imagePrompts.push({ prompt: "a woman laughing, no hats, studio", actor: "user" });
    ollama.s.refines.push({ prompt: "woman, wide smile, without glasses, studio light", avoid: "crowd, text" });
    const out = await say("p1", [...chat("hello"), a("x"), u("/draw Bea laughing")]);
    expect(out).toContain("https://game.example/images/");
    const writer = JSON.stringify(ollama.calls("image_prompt").at(-1)!.body.messages);
    expect(writer).toContain("a green apron");
    expect(writer).toContain("pink");
    expect(writer).toContain('phase');
    const wf = workflow();
    expect(wf["6"].inputs.text).toContain("wide smile");
    expect(wf["6"].inputs.text).not.toContain("without");
    expect(wf["6"].inputs.text).toContain("pink"); // gak_colors came back
    expect(wf["6"].inputs.text).toContain("a green apron");
    expect(wf["7"].inputs.text).toBe("blurry, hats, glasses, crowd, text");
  });
  it("uses the cleaned prompt when the refine judge is down", async () => {
    await say("p2", chat("hello"));
    ollama.s.imagePrompts.push({ prompt: "a door, no people", actor: null });
    ollama.s.judgeDown = true;
    const out = await say("p2", [...chat("hello"), a("x"), u("/draw a door")]);
    expect(out).not.toContain("could not be made");
  });
});

describe("the keepsake", () => {
  it("is not offered before the end, nor to anyone but the leader", async () => {
    await say("k1", chat("hello"));
    expect(await say("k1", [...chat("hello"), a("x"), u("/keepsake")])).toBe("The game is not over yet.");
    const log = await finish("k2");
    expect(await say("k2", [...log, a("x"), u("/keepsake")])).toContain("Pick your keepsake:");
    // a second chat where nobody reached a goal: no leader
    await say("k3", chat("hello"));
    await say("k3", chat("hello", "b"));
    await say("k3", chat("hello", "b", "c"));
    expect(await say("k3", [...chat("hello", "b", "c", "d"), a("x"), u("/keepsake")])).toBe("The keepsake is for the person who got the most goals.");
  });
  it("lists the options with the person's own words filled in, draws the chosen one once, with the recorded looks", async () => {
    const log = await finish("k4");
    const list = await say("k4", [...log, a("x"), u("/keepsake")]);
    expect(list).toContain("1. the happy real winner of Gak Show, Bea, thumbnail");
    expect(list).toContain("2. a small trophy engraved Bea");
    expect(list).toContain("Send /keepsake and the number.");
    expect(await say("k4", [...log, a("x"), u("/keepsake 9")])).toBe("Pick a number from the list.");
    ollama.s.imagePrompts.push({ prompt: "happy woman, thumbnail", actor: "npc_bo" }); // the judge may name someone else: the keepsake is of the winner
    const pic = await say("k4", [...log, a("x"), u("/keepsake 1")]);
    expect(pic).toContain("https://game.example/images/");
    expect(String(ollama.calls("image_prompt").at(-1)!.body.messages[1].content)).toContain("happy real winner of Gak Show");
    expect(workflow()["6"].inputs.text).toContain("pink");
    expect(await say("k4", [...log, a("x"), u("/keepsake 2")])).toBe("You already have your keepsake.");
    expect(sessions.get("chat:k4")!.visuals!.keepsake!.claimed.user).toContain("Gak Show");
  });
  it("does not use up the keepsake when the picture could not be made", async () => {
    const log = await finish("k5");
    renderer.s.status = 500;
    expect(await say("k5", [...log, a("x"), u("/keepsake 1")])).toBe("The picture could not be made.");
    renderer.s.status = 200;
    expect(await say("k5", [...log, a("x"), u("/keepsake 1")])).toContain("https://game.example/images/");
  });
});
