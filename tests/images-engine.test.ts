import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { makeRenderer, PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
process.env.PUBLIC_URL = "https://game.example";
process.env.IMAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "img-engine-"));
const ollama = makeOllama();
let renderer: ReturnType<typeof makeRenderer>;
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  renderer = makeRenderer();
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset();
  renderer.s.calls.length = 0; renderer.s.output = PNG; renderer.s.delayMs = 0; renderer.s.status = 200; renderer.s.uploads = 0; renderer.s.pendingPolls = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

type M = { role: string; content: unknown };
const u = (content: unknown): M => ({ role: "user", content });
const a = (content: string): M => ({ role: "assistant", content });
const key = (id: string) => "chat:" + id;
async function say(id: string, messages: M[]): Promise<string> {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  if (r.status !== 200) throw new Error("status " + r.status + " " + r.text);
  await sessions.get(key(id))?.tail;
  return r.body.choices[0].message.content;
}
const start = async (id: string): Promise<M[]> => { const t = await say(id, [u("let us begin")]); return [u("let us begin"), a(t)]; };
const urlIn = (text: string) => /!\[[^\]]*\]\((https:\/\/game\.example\/images\/[a-f0-9]{24}\.png)\)/.exec(text)?.[1];
const sentWorkflow = () => JSON.parse(JSON.stringify(renderer.s.calls.find((c) => c.path === "/prompt")!.body.prompt));

describe("/draw and /portrait", () => {
  it("keeps personal details out of the prompt the renderer receives", async () => {
    const base = await start("d-pii");
    ollama.s.imagePrompts.push({ prompt: "a keeper holding a card 4111 1111 1111 1111, mail bea@example.com", actor: null });
    await say("d-pii", [...base, u("/draw the keeper")]);
    const text = JSON.stringify(sentWorkflow());
    expect(text).not.toContain("4111 1111");
    expect(text).not.toContain("bea@example.com");
    expect(text).toMatch(/\[card:[0-9a-f]{6}\]/);
  });

  it("makes a picture without a round, serves it, and tells the narrator nothing", async () => {
    const base = await start("d1");
    ollama.s.imagePrompts.push({ prompt: "an open wooden door, dim light", actor: null });
    const before = ollama.calls("narrator").length;
    const reply = await say("d1", [...base, u("/draw the door")]);
    const url = urlIn(reply)!;
    expect(url).toBeTruthy();
    expect(reply).toContain("the door");
    expect(ollama.calls("narrator")).toHaveLength(before);
    expect(renderer.paths()).toEqual(["/prompt", "/history/p1", "/view", "/free"]);
    const wf = sentWorkflow();
    expect(wf["6"].inputs.text).toBe("oil painting, an open wooden door, dim light, highly detailed");
    expect(wf["7"].inputs.text).toBe("blurry, text");
    expect(wf["5"].inputs).toEqual({ width: 512, height: 640 });
    const unloads = ollama.calls("unload").map((c) => c.body);
    expect(unloads).toContainEqual(expect.objectContaining({ keep_alive: 0 }));
    const served = await request(app).get(new URL(url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect((await request(app).get("/images/../package.json")).status).toBe(404);
    expect((await request(app).get("/images/" + "0".repeat(24) + ".png")).status).toBe(404);
    // the command and its reply are not rounds: the next real message is round 2
    await say("d1", [...base, u("/draw the door"), a(reply), u("I walk in")]);
    expect(sessions.get(key("d1"))!.snapshots).toHaveLength(3);
  });

  it("answers before any game exists", async () => {
    expect(await say("d2", [u("/draw anything")])).toBe("There is no game here yet.");
    expect(renderer.s.calls).toHaveLength(0);
  });

  it("keeps one seed per actor: config.json's for Bo, a random one kept for Bea", async () => {
    const base = await start("d3");
    await say("d3", [...base, u("/portrait Bo")]);
    expect(sentWorkflow()["3"].inputs.seed).toBe(4242);
    renderer.s.calls.length = 0;
    await say("d3", [...base, u("/portrait bea")]);
    const first = sentWorkflow()["3"].inputs.seed;
    expect(Number.isInteger(first)).toBe(true);
    expect(sessions.get(key("d3"))!.visuals!.seeds).toEqual({ npc_bo: 4242, user: first });
    renderer.s.calls.length = 0;
    await say("d3", [...base, u("/portrait Bea")]);
    expect(sentWorkflow()["3"].inputs.seed).toBe(first);
  });

  it("says who it does not know", async () => {
    const base = await start("d4");
    expect(await say("d4", [...base, u("/portrait Zed")])).toBe('I don\'t know who "Zed" is.');
    expect(await say("d4", [...base, u("/portrait")])).toContain("know who");
  });

  it("uses the first portrait as that actor's reference afterwards", async () => {
    const base = await start("d5");
    await say("d5", [...base, u("/portrait Bo")]);
    expect(renderer.s.uploads).toBe(0);
    const ref = sessions.get(key("d5"))!.visuals!.refs.npc_bo;
    expect(ref).toMatch(/\.png$/);
    renderer.s.calls.length = 0;
    await say("d5", [...base, u("/portrait Bo")]);
    expect(renderer.s.uploads).toBe(1);
    expect(sentWorkflow()["10"].inputs.image).toBe("ref-1.png");
  });

  it("takes a picture attached to /portrait as the reference, and refuses one it cannot use", async () => {
    const base = await start("d6");
    const withImage = (data: string) => u([{ type: "text", text: "/portrait Bea" }, { type: "image_url", image_url: { url: data } }]);
    await say("d6", [...base, withImage("data:image/png;base64," + PNG.toString("base64"))]);
    expect(renderer.s.uploads).toBe(1);
    expect(sessions.get(key("d6"))!.visuals!.refs.user).toMatch(/\.png$/);
    const bad = await say("d6", [...base, withImage("data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"))]);
    expect(bad).toBe("I can only use PNG, JPEG or WebP images; that file is svg.");
  });

  it("uses the character the prompt writer says the scene is of, for the seed", async () => {
    const base = await start("d7");
    ollama.s.imagePrompts.push({ prompt: "a bearded man at a door", actor: "npc_bo" });
    await say("d7", [...base, u("/draw the man at the door")]);
    expect(sentWorkflow()["3"].inputs.seed).toBe(4242);
    ollama.s.imagePrompts.push({ prompt: "x", actor: "npc_nobody" }); // not an actor: ignored
    renderer.s.calls.length = 0;
    await say("d7", [...base, u("/draw something")]);
    expect(sessions.get(key("d7"))!.visuals!.seeds).toEqual({ npc_bo: 4242 });
  });

  it("falls back to the plain request when the prompt writer is down", async () => {
    const base = await start("d8");
    ollama.s.judgeDown = true;
    const reply = await say("d8", [...base, u("/draw a lamp")]);
    expect(urlIn(reply)).toBeTruthy();
    expect(sentWorkflow()["6"].inputs.text).toContain("a lamp");
  });

  it("reports a failed render, an unusable result and a full queue in the game's words", async () => {
    const base = await start("d9");
    renderer.s.status = 500;
    expect(await say("d9", [...base, u("/draw a")])).toBe("The picture could not be made.");
    renderer.s.status = 200;
    renderer.s.output = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await say("d9", [...base, u("/draw a")])).toBe("I can only use PNG, JPEG or WebP images; that file is svg.");
    renderer.s.output = PNG;
    renderer.s.delayMs = 80;
    const [x, y, z] = await Promise.all(["q1", "q2", "q3"].map(async (id) => say(id + "z", await start(id + "z").then((b) => [...b, u("/draw a")]))));
    const texts = [x, y, z];
    expect(texts.filter((t) => urlIn(t))).toHaveLength(2);
    expect(texts).toContain("Too many pictures are waiting. Try again in a bit.");
  });

  it("holds the narrator back while a picture is rendering", async () => {
    const base = await start("d10");
    renderer.s.delayMs = 120;
    const order: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (i: string | URL | Request, init?: RequestInit) => {
      const url = String(i);
      if (url.endsWith("/free")) order.push("free");
      if (url.endsWith("/chat/completions") && !String(init?.body).includes("response_format")) order.push("narrator");
      return prev(i, init);
    }) as typeof fetch;
    try {
      const draw = say("d10", [...base, u("/draw a")]);
      await new Promise((r) => setTimeout(r, 40));
      await say("d10", [...base, u("I wait")]);
      await draw;
    } finally { globalThis.fetch = prev; }
    expect(order.indexOf("free")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("free")).toBeLessThan(order.lastIndexOf("narrator"));
  });
});

describe("picture offers", () => {
  it("offers when the judge reads a request, and renders only after yes", async () => {
    const base = await start("o1");
    ollama.s.offers.push({ wants: true, subject: "the lamp" });
    const offer = await say("o1", [...base, u("can you draw me a picture of the lamp")]);
    expect(offer).toBe('Make an image of "the lamp"? Reply yes to make it.');
    expect(renderer.s.calls).toHaveLength(0);
    const reply = await say("o1", [...base, u("can you draw me a picture of the lamp"), a(offer), u("yes")]);
    expect(urlIn(reply)).toBeTruthy();
    expect(sessions.get(key("o1"))!.visuals!.offer).toBeUndefined();
    expect(sessions.get(key("o1"))!.snapshots).toHaveLength(2);
  });
  it("ignores messages without the game's trigger words, and requests the judge says no to", async () => {
    const base = await start("o2");
    await say("o2", [...base, u("I look at the lamp")]);
    expect(ollama.calls("image_offer")).toHaveLength(0);
    ollama.s.offers.push({ wants: false, subject: "" });
    await say("o2", [...base, u("do you see a picture on the wall?")]);
    expect(ollama.calls("image_offer")).toHaveLength(1);
    expect(renderer.s.calls).toHaveLength(0);
    ollama.s.offers.push({ wants: true, subject: "" }); // no subject: not an offer
    await say("o2", [...base, u("draw me a picture")]);
    expect(sessions.get(key("o2"))!.visuals?.offer).toBeUndefined();
  });
  it("a yes with nothing offered is just the failed text", async () => {
    const base = await start("o3");
    const offer = 'Make an image of "x"? Reply yes to make it.';
    expect(await say("o3", [...base, u("picture of x"), a(offer), u("yes")])).toBe("The picture could not be made.");
  });
});
