import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";
import type { Who } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/owner");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { ensureOwnership, ownerCommand } = await import("../src/utils/owner.js");

const ollama = makeOllama();
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" }, cy: Who = { id: "u-cy", name: "Cy" };
const KEY = "chat:own";
const HOUR = 3_600_000;
let clock = 1_700_000_000_000;
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear(); clock = 1_700_000_000_000;
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => { jest.restoreAllMocks(); });

const start = async () => { const t = makeChat(app, "own"); await t.send(bea, "Let's play"); await settle(); return t; };

describe("owner", () => {
  it("the first real person to speak owns the chat; anonymous speakers never do", async () => {
    const t = makeChat(app, "own");
    await t.send(null, "Let's play"); await settle();
    expect(sessions.get(KEY)!.owner).toBeUndefined();
    expect(await t.send(null, "/owner")).toBe("This chat has no owner.");
    await t.send(bea, "I look around"); await settle();
    expect(sessions.get(KEY)!.owner).toEqual({ userId: "u-bea", name: "Bea" });
    expect(await t.send(bo, "/owner")).toBe("The owner is Bea. Successors: nobody. Telemetry: off.");
  });

  it("another person speaking, or a different chat id, does not move ownership", async () => {
    const t = await start();
    await t.send(bo, "Hello"); await settle();
    expect(sessions.get(KEY)!.owner!.userId).toBe("u-bea");
    expect(await t.send(bo, "/successor add Bea")).toBe("Only the owner, Bea, can do that.");
  });

  it("successors are real people who spoke here, in order, and only the owner names them", async () => {
    const t = await start();
    await t.send(bo, "Hi"); await t.send(cy, "Hi");
    expect(await t.send(bea, "/successor add Zed")).toBe('I don\'t know a person called "Zed" here.');
    expect(await t.send(bea, "/successor add Bo")).toBe("Bo is now a successor (number 1).");
    expect(await t.send(bea, "/successor add cy")).toBe("Cy is now a successor (number 2).");
    expect(await t.send(bo, "/successor")).toBe("Successors, in order: Bo, Cy.");
    expect(await t.send(bea, "/successor remove Bo")).toBe("Bo is no longer a successor.");
    expect(await t.send(bea, "/successor nope")).toBe("Use /successor add <name>, /successor remove <name> or /successor.");
  });

  it("nobody can claim while the owner is around", async () => {
    const t = await start();
    await t.send(bo, "Hi");
    await t.send(bea, "/successor add Bo");
    expect(await t.send(bo, "/claim")).toBe("The owner is not away, so there is nothing to claim.");
    expect(await t.send(bea, "/claim")).toBe("The owner is not away, so there is nothing to claim.");
  });

  it("an away successor is skipped: the first one still around is next in line", async () => {
    const t = await start();
    await t.send(bo, "Hi"); await t.send(cy, "Hi");
    await t.send(bea, "/successor add Bo"); await t.send(bea, "/successor add Cy");
    const day = new Date(clock).toISOString().slice(0, 10);
    clock += 2 * HOUR; await t.send(cy, "still here"); await settle(); // Cy is seen; Bea and Bo are away
    expect(await t.send(bo, "/claim")).toBe("Cy is next in line to claim this chat.");
    expect(await t.send(cy, `/claim ${day}`)).toBe("What name did the first owner use?");
    expect(await t.send(cy, "/claim Bea")).toBe("Cy is now the owner of this chat.");
    expect(sessions.get(KEY)!.owner!.userId).toBe("u-cy");
    expect(sessions.get(KEY)!.own!.successors.map((p) => p.name)).toEqual(["Bo"]);
  });

  it("claim: questions one by one, wrong answers lock the claimant out, the owner returning resets it", async () => {
    const t = await start();
    await t.send(bo, "Hi");
    await t.send(bea, "/successor add Bo");
    const day = new Date(clock).toISOString().slice(0, 10);
    clock += 2 * HOUR; await t.send(bo, "anyone?"); await settle();
    expect(await t.send(bo, "/claim")).toBe("On what day did this chat begin? (YYYY-MM-DD)");
    expect(await t.send(bo, "/claim 1999-01-01")).toBe("That is not right. 1 tries left.");
    expect(await t.send(bo, "/claim 1999-01-02")).toBe("Too many wrong answers. This stays locked until the owner returns.");
    expect(await t.send(bo, `/claim ${day}`)).toBe("Too many wrong answers. This stays locked until the owner returns.");
    await t.send(bea, "I'm back"); await settle();
    clock += 2 * HOUR; await t.send(bo, "anyone?"); await settle();
    expect(await t.send(bo, `/claim ${day}`)).toBe("What name did the first owner use?");
    expect(await t.send(bo, "/claim bea")).toBe("Bo is now the owner of this chat.");
    expect(sessions.get(KEY)!.owner).toEqual({ userId: "u-bo", name: "Bo" });
    ollama.s.narration = "A door creaks.";
    expect(await t.send(bo, "I open it")).toBe("A door creaks.\n\nBo is now the owner of this chat.");
    expect(await t.send(bo, "I step in")).not.toContain("now the owner");
  });

  it("answers are stored hashed by default", async () => {
    await start();
    const own = sessions.get(KEY)!.own!;
    expect(own.challenge).toHaveLength(2);
    expect(own.challenge.every((c) => /^[0-9a-f]{64}$/.test(c.a))).toBe(true);
    expect(JSON.stringify(own)).not.toContain("1970");
  });

  it("with nobody to inherit and the default fallback, the chat closes for anyone but the owner", async () => {
    const t = await start();
    await t.send(bo, "Hi");
    clock += 2 * HOUR;
    expect(await t.send(bo, "anyone there?")).toBe("The owner has been away and nobody can take over, so this chat is closed.");
    expect(await t.send(bea, "I'm back")).toBe("The torch flickers.");
    expect(await t.send(bo, "me too")).toBe("The torch flickers.");
  });

  it("an owner who is frozen is still the owner; an NPC can never be named", async () => {
    const t = await start();
    const s = sessions.get(KEY)!;
    s.frozen = { user: { kind: "player", at: clock } as never };
    expect(s.owner!.userId).toBe("u-bea");
    expect(await t.send(bea, "/successor add user")).toBe('I don\'t know a person called "user" here.');
  });

  it("units: ownership is never created for anonymous, and /owner works without a session owner", () => {
    const s = { snapshots: [], unsynced: [], tail: Promise.resolve(), mode: "game" } as never;
    ensureOwnership(s, { userId: "anonymous", name: "Player" }, clock);
    expect((s as { owner?: unknown }).owner).toBeUndefined();
    expect(ownerCommand("telemetry", "off", { session: s, who: { userId: "anonymous", name: "Player" }, now: clock })).toBe("This chat has no owner.");
  });
});

describe("keeping the room", () => {
  it("after a week the owner is asked once, with suggestions; /keep ends it; /handover passes the room on", async () => {
    const t = await start();
    for (let i = 0; i < 6; i++) { await t.send(bo, "I follow"); clock += HOUR; } await settle(); // Bo is active
    await t.send(cy, "hi"); await settle();
    clock += 8 * 24 * HOUR;
    await t.send(bo, "back"); await settle(); clock += HOUR; // Bo is recent again
    const asked = await t.send(bea, "I look around"); await settle();
    expect(asked).toContain("Keep it with /keep");
    expect(asked).toMatch(/Suggested: Bo/);
    const again = await t.send(bea, "more"); await settle();
    expect(again).not.toContain("Keep it with /keep"); // asked once
    expect(await t.send(bo, "/keep")).toBe("Only the owner, Bea, can do that.");
    expect(await t.send(bea, "/keep")).toBe("Bea keeps the room.");
    expect(await t.send(bea, "/keep")).toBe("Nobody is asking you anything right now.");
    expect(await t.send(bea, "/handover Bo")).toContain("Bo is now the owner of this chat (handed over by Bea)");
    expect(sessions.get(KEY)!.owner!.userId).toBe("u-bo");
    expect(await t.send(bea, "/handover Cy")).toBe("Only the owner, Bo, can do that.");
  });
});
