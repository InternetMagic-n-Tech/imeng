import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { makeRenderer, PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/keepsake-judge");
process.env.PUBLIC_URL = "https://game.example";
process.env.IMAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "keepsake-judge-"));
const ollama = makeOllama();
let renderer: ReturnType<typeof makeRenderer>;
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { renderer = makeRenderer(); ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => {
  ollama.reset();
  renderer.s.calls.length = 0; renderer.s.output = PNG; renderer.s.status = 200;
  for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});

type M = { role: string; content: string };
const u = (content: string): M => ({ role: "user", content });
const a = (content: string): M => ({ role: "assistant", content });
const say = async (id: string, messages: M[]): Promise<string> => {
  const r = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)?.tail;
  return r.body.choices[0].message.content;
};
const chat = (...lines: string[]): M[] => lines.flatMap((l, i) => (i < lines.length - 1 ? [u(l), a("x")] : [u(l)]));

describe("a judge of its own for the pictures and the keepsake options", () => {
  it("the prompt is written by one model, refined by a bigger one, and the options are proposed once", async () => {
    await say("j1", chat("hello"));
    await say("j1", [...chat("hello"), a("x"), u("/goal wear pink gak")]);
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "pink gak lands" }] });
    ollama.s.narration = "Pink gak lands on Bea.";
    await say("j1", chat("hello", "two"));
    await say("j1", chat("hello", "two", "three"));
    const log = chat("hello", "two", "three", "four");
    ollama.s.keepsakeOptions.push({ options: ["a tiny gold trophy for {name}", "a poster of {name} in {gak_colors}", "a third that is cut off"] });
    const list = await say("j1", [...log, a("x"), u("/keepsake")]);
    expect(list).toContain("1. a tiny gold trophy for Bea");
    expect(list).toContain("2. a poster of Bea in pink");
    expect(list).not.toContain("third"); // max_options 2
    expect(ollama.calls("keepsake_options")[0].body.model).toBe("refine-big");
    await say("j1", [...log, a("x"), u("/keepsake")]);
    expect(ollama.calls("keepsake_options")).toHaveLength(1); // proposed once, kept
    const pic = await say("j1", [...log, a("x"), u("/keepsake 1")]);
    expect(pic).toContain("https://game.example/images/");
    expect(ollama.calls("image_prompt").at(-1)!.body.model).toBe("prompt-big");
    expect(ollama.calls("image_refine").at(-1)!.body.model).toBe("refine-big");
  });
  it("says there is nothing to offer when the judge proposes nothing or is down", async () => {
    await say("j2", chat("hello"));
    await say("j2", [...chat("hello"), a("x"), u("/goal wear pink gak")]);
    ollama.s.goalMarks.push({ reached: [{ id: "g1", quote: "pink gak lands" }] });
    ollama.s.narration = "Pink gak lands on Bea.";
    await say("j2", chat("hello", "two"));
    await say("j2", chat("hello", "two", "three"));
    const log = chat("hello", "two", "three", "four");
    ollama.s.judgeDown = true;
    expect(await say("j2", [...log, a("x"), u("/keepsake")])).toBe("There is no keepsake to offer.");
    ollama.s.judgeDown = false;
    ollama.s.keepsakeOptions.push({ options: [] });
    expect(await say("j2", [...log, a("x"), u("/keepsake")])).toBe("There is no keepsake to offer.");
  });
});
