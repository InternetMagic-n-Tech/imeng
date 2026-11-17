import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/hands");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const say = async (id: string, texts: string[]) => {
  const messages = texts.flatMap((t, i) => (i === 0 ? [{ role: "user", content: t }] : [{ role: "assistant", content: "ok" }, { role: "user", content: t }]));
  ollama.s.narration = "ok"; ollama.s.extractor.push([]);
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages });
  await sessions.get("chat:" + id)!.tail;
  return JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages);
};

describe("a hand per player", () => {
  it("shows a dealt hand first, then plays only a card that is really in it", async () => {
    const p1 = await say("h1", ["I cast a spell"]);
    expect(p1).toContain("has not played a card yet");
    const hand = sessions.get("chat:h1")!.deck!.hands!.user!;
    expect(hand.length).toBe(3);
    const named = `${hand[0]!.rank} of ${hand[0]!.suit}`;
    const p2 = await say("h1", ["I cast a spell", `I play the ${named}`]);
    expect(p2).toContain(`PLAYS ${named}`);
    const after = sessions.get("chat:h1")!.deck!;
    expect(after.hands!.user!.length).toBe(3);
    expect(after.cards.length + after.hands!.user!.length).toBe(52);
    expect(after.hands!.user!.map((c) => c.rank + c.suit)).not.toContain(hand[0]!.rank + hand[0]!.suit);
  });
});

describe("the deck rolls back with a regenerate", () => {
  it("an edited turn is dealt the same hand again", async () => {
    await say("h2", ["I cast a spell"]);
    const first = JSON.stringify(sessions.get("chat:h2")!.deck!.hands!.user);
    await say("h2", ["I cast a spell", "I cast again"]);
    await say("h2", ["I cast a spell EDITED"]); // the player went back to turn 1 and edited it
    expect(JSON.stringify(sessions.get("chat:h2")!.deck!.hands!.user)).toBe(first);
  });
});
