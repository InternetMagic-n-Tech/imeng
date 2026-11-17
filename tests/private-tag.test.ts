import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";
import { TagFilter, OutFilter } from "../src/utils/text.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/private");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ sessions } = await import("../src/utils/sessions.js"));
});
beforeEach(() => {
  ollama.reset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

const run = (chunks: string[]): string => { const f = new TagFilter("private"); return chunks.map((c) => f.push(c)).join("") + f.end(); };

describe("TagFilter", () => {
  it("takes the block out, whatever the case", () => {
    expect(run(["He nods. <private>the tattoo hurts</private> Then leaves."])).toBe("He nods.  Then leaves.");
    expect(run(["a <PRIVATE>x</Private> b"])).toBe("a  b");
  });
  it("copes with tags split across chunks, one character at a time", () => {
    const text = "Hi <private>secret</private> bye";
    expect(run(text.split(""))).toBe("Hi  bye");
    expect(run(["Hi <priv", "ate>sec", "ret</pri", "vate> bye"])).toBe("Hi  bye");
  });
  it("lets a lookalike through, and an unclosed tag is prose, not a block", () => {
    expect(run(["1 < 2 and <p>x</p> and <priv>"])).toBe("1 < 2 and <p>x</p> and <priv>");
    expect(run(["visible <private>never closed"])).toBe("visible <private>never closed");
  });
  it("shows the tag as written when it is in backticks, and still hides a real block after it", () => {
    expect(run(["Use the `<private>` tag for notes. <private>secret</private>Done."])).toBe("Use the `<private>` tag for notes. Done.");
    expect(run(["```\n<private>x</private>\n```"])).toBe("```\n<private>x</private>\n```");
    expect(run("say `<pri vate>` ok `<private>` and <private>hid</private>!".split(""))).toBe("say `<pri vate>` ok `<private>` and !");
  });
  it("OutFilter keeps the raw text for the bookkeeping", () => {
    const f = new OutFilter(false, true);
    const shown = f.push("Ok <private>note</private>") + f.end();
    expect(shown).toBe("Ok ");
    expect(f.raw).toBe("Ok <private>note</private>");
    expect(f.hid).toBe(true);
    const off = new OutFilter(false, false);
    expect(off.push("Ok <private>note</private>") + off.end()).toBe("Ok <private>note</private>");
  });
});

const post = (id: string, stream: boolean) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ stream, messages: [{ role: "user", content: "hello" }] });
const sse = (text: string): string => text.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? "").join("");

describe("<private> in a narrator reply", () => {
  it("never reaches the player (whole reply), but the extractor still reads it", async () => {
    ollama.s.narration = "The Host smiles. <private>Bea's tattoo is not healed.</private>";
    const r = await post("p1", false);
    expect(r.body.choices[0].message.content).toBe("The Host smiles. ");
    await sessions.get("chat:p1")!.tail;
    expect(JSON.stringify(ollama.calls("extractor").map((c) => c.body))).toContain("tattoo is not healed");
  });
  it("never reaches the player (streamed)", async () => {
    ollama.s.narration = "The Host smiles. <private>Bea's tattoo is not healed.</private> Next.";
    const r = await post("p2", true);
    expect(sse(r.text)).toBe("The Host smiles.  Next.");
    expect(r.text).not.toContain("tattoo");
    await sessions.get("chat:p2")!.tail;
  });
  it("a reply that is only private shows the game's placeholder, whole and streamed", async () => {
    ollama.s.narration = "<private>only notes</private>";
    expect((await post("p3", false)).body.choices[0].message.content).toBe("The Host makes notes.");
    expect(sse((await post("p4", true)).text)).toBe("The Host makes notes.");
    await sessions.get("chat:p4")!.tail;
  });
});
