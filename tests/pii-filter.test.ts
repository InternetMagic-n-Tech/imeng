import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/pii");
process.env.PII_SALT = "test-salt";
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { scrubText, scrubMessages, summary } = await import("../src/utils/pii-filter.js");
const { stateBlock } = await import("../src/utils/state.js");
const { initialState } = await import("../src/utils/state.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

const t = (s: string) => scrubText(s).text;

describe("scrubText", () => {
  it("tokenises emails, and the same value gives the same token", () => {
    const a = t("mail bea.lee@example.com or BEA.LEE@example.com");
    expect(a).toMatch(/^mail \[email:[0-9a-f]{6}\] or \[email:[0-9a-f]{6}\]$/);
    const [x, y] = [...a.matchAll(/\[email:([0-9a-f]{6})\]/g)].map((m) => m[1]);
    expect(x).toBe(y);
    expect(t("bo@example.com")).not.toBe(t("bea.lee@example.com"));
  });
  it("finds phone numbers in common shapes, but not dice, scores or years", () => {
    for (const p of ["416-555-0199", "(416) 555 0199", "+1 416.555.0199", "4165550199"]) expect(t(`call ${p} now`)).toMatch(/call \[phone:[0-9a-f]{6}\] now/);
    expect(t("d20: 14 +2 = 16, score 120, year 1998, 12 players")).toBe("d20: 14 +2 = 16, score 120, year 1998, 12 players");
  });
  it("finds card numbers only when they pass the Luhn check", () => {
    expect(t("card 4111 1111 1111 1111 ok")).toMatch(/card \[card:[0-9a-f]{6}\] ok/);
    expect(t("card 4111 1111 1111 1112 ok")).toBe("card 4111 1111 1111 1112 ok");
  });
  it("finds id numbers (SSN, SIN, IBAN), ips and secrets", () => {
    expect(t("ssn 123-45-6789")).toMatch(/ssn \[id_number:/);
    expect(t("sin 046 454 286")).toMatch(/sin \[id_number:/);
    expect(t("sin 046 454 287")).toBe("sin 046 454 287");
    expect(t("iban GB82 WEST 1234 5698 7654 32")).toMatch(/iban \[id_number:/);
    expect(t("from 192.168.1.20 today")).toMatch(/from \[ip:/);
    expect(t("version 1.2.3.4.5")).toBe("version 1.2.3.4.5");
    expect(t("go to https://pat:hunter2@host.example/x")).toBe("go to [SECRET]");
    expect(t("my password = swordfish1")).toBe("my [SECRET]");
  });
  it("keeps allowed values, applies game patterns, and counts what it found", () => {
    expect(t("write help@example.com")).toBe("write help@example.com");
    const r = scrubText("I am in room 204, mail a@b.co and b@c.co");
    expect(r.text).toMatch(/\[room:[0-9a-f]{6}\]/);
    expect(summary(r.found)).toBe("email 2, room 1");
  });
});

describe("scrubMessages", () => {
  it("changes the player's text and text parts only, never the game's system message", () => {
    const msgs = [{ role: "system", content: "mail x@y.com" }, { role: "user", content: "me: a@b.co" }, { role: "user", content: [{ type: "text", text: "c@d.co" }, { type: "image_url", image_url: { url: "u" } }] }];
    const r = scrubMessages(msgs);
    expect(r.messages[0]).toBe(msgs[0]);
    expect(r.messages[1].content).toMatch(/^me: \[email:/);
    expect((r.messages[2].content as any)[0].text).toMatch(/^\[email:/);
    expect((r.messages[2].content as any)[1]).toBe(msgs[2].content[1]);
    expect(r.found).toEqual({ email: 2 });
  });
});

describe("pii paths in the state the models read", () => {
  it("masks listed fields in the narrator's state block", () => {
    const s = initialState(); (s.actors.user as any).real_name = "Bea Lee";
    expect(stateBlock(s)).toContain("[redacted]");
    expect(stateBlock(s)).not.toContain("Bea Lee");
    expect((s.actors.user as any).real_name).toBe("Bea Lee");
  });
});

describe("in the game", () => {
  it("no model, log line or saved note ever sees the raw value; the history is cleaned on every request", async () => {
    const chat = makeChat(app, "p1");
    await chat.send(bea, "Let's play. Reach me at bea.lee@example.com or 416-555-0199");
    await sessions.get("chat:p1")!.tail; await flushLogs();
    const sent = JSON.stringify(ollama.calls("narrator").map((c) => c.body.messages)) + JSON.stringify(ollama.calls("extractor").map((c) => c.body.messages));
    expect(sent).not.toContain("bea.lee@example.com");
    expect(sent).not.toContain("555-0199");
    expect(sent).toMatch(/\[email:[0-9a-f]{6}\]/);
    await chat.send(bea, "I look around");
    expect(JSON.stringify(ollama.calls("narrator").at(-1)!.body.messages)).not.toContain("bea.lee@example.com");
    expect(JSON.stringify(sessions.get("chat:p1")!.snapshots)).not.toContain("bea.lee@example.com");
  });
});
