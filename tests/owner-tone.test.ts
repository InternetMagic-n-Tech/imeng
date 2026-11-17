import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";
import type { Who } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/owner-tone");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" }, cy: Who = { id: "u-cy", name: "Cy" };
const KEY = "chat:own";
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("tone as a condition of being a successor", () => {
  it("invite after a few turns; nothing is judged until they accept; a low score or no consent blocks naming; a good one allows it", async () => {
    const t = makeChat(app, "own");
    await t.send(bea, "Let's play"); await settle();
    for (let i = 0; i < 4; i++) { await t.send(bo, `I follow ${i}`); await t.send(cy, `me too ${i}`); } await settle();
    const s = () => sessions.get(KEY)!;
    expect(s().own!.people["u-bo"].consent).toBe("pending");
    expect(s().announcements!.some((a) => a.kind === "successor_invite" && a.to === "u-bo")).toBe(true);
    expect(ollama.calls("tone")).toHaveLength(0); // nothing judged without a yes
    expect(await t.send(bea, "/successor add Bo")).toContain("has not agreed to be considered");
    expect(await t.send(bo, "/successor accept")).toContain("may be considered");
    ollama.s.tones.push(0.3);
    for (let i = 0; i < 4; i++) { await t.send(bo, `grr ${i}`); await t.send(cy, `ok ${i}`); } await settle();
    expect(s().own!.people["u-bo"].tone).toBe(0.3);
    expect(s().own!.people["u-bo"].recent!.length).toBeLessThan(3); // the words that were read are dropped
    expect(await t.send(bea, "/successor add Bo")).toContain("not rated high enough");
    ollama.s.tones.push(0.9);
    for (let i = 0; i < 4; i++) await t.send(bo, `thanks everyone ${i}`); await settle();
    expect(await t.send(bea, "/successor add Bo")).toContain("Bo is now a successor");
  });
  it("declining erases the score and the successor place, and the owner cannot answer for anyone", async () => {
    const t = makeChat(app, "own");
    await t.send(bea, "Let's play"); await settle();
    for (let i = 0; i < 4; i++) await t.send(bo, `hi ${i}`); await settle();
    await t.send(bo, "/successor accept");
    expect(await t.send(bea, "/successor accept")).toBe("You are the owner.");
    expect(await t.send(bo, "/successor decline")).toContain("not be considered");
    const p = sessions.get(KEY)!.own!.people["u-bo"];
    expect(p.consent).toBe("no"); expect(p.tone).toBeUndefined();
  });
});
