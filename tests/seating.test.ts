import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-seating");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { SEATING } = await import("../src/utils/config.js");
const { parseCommand } = await import("../src/utils/commands.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" }, cy = { id: "u-cy", name: "Cy" };
const TABLE = "cccccccc-3333-4333-8333-cccccccccccc", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)?.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The cards are out.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("seating with owner approval", () => {
  const start = async () => { const t = makeChat(app, TABLE); await t.send(bea, "Let's play"); await settle(); return t; };
  const room = () => sessions.get(KEY)!.room!;
  const actorOf = (name: string) => Object.values(sessions.get(KEY)!.snapshots.at(-1)!.actors).find((x: any) => x.name === name) as any;

  it("is configured for owner approval", () => {
    expect(SEATING).toMatchObject({ approval: "owner", phases: ["between"], minAge: 21 });
  });

  it("a confirmed request waits for the owner, who sees it, approves it, and the person is seated", async () => {
    const t = await start();
    await t.send(bo, "/seat 30 male");
    expect(await t.send(bo, "/seat yes")).toMatch(/with the table owner/);
    expect(room().players["u-bo"]).toBeUndefined();
    expect(await t.send(bo, "/seat approve Bo")).toMatch(/Only the table owner/);
    expect(await t.send(bea, "/seat list")).toMatch(/Bo asks for a seat: age 30, male, straight/);
    expect(sessions.get(KEY)!.announcements!.some((e) => e.kind === "seat" && e.to === "u-bea" && /Bo asks/.test(e.text))).toBe(true);
    expect(await t.send(bea, "/seat approve bo")).toBe("Bo is approved for a seat. Bo has a seat.");
    expect(room().players["u-bo"]).toBeDefined();
    expect(actorOf("Bo")).toMatchObject({ age: 30, gender: "male", sexuality: "straight" });
    expect(room().seatQueue).toEqual([]);
  });

  it("the owner can deny, the person is told, and may ask again", async () => {
    const t = await start();
    await t.send(bo, "/seat 30 male"); await t.send(bo, "/seat yes");
    expect(await t.send(bea, "/seat deny Bo")).toBe("Bo will not be seated.");
    expect(room().seatQueue).toEqual([]);
    expect(sessions.get(KEY)!.announcements!.some((e) => e.to === "u-bo" && /did not approve/.test(e.text))).toBe(true);
    expect(await t.send(bea, "/seat approve Bo")).toMatch(/Nobody called Bo/);
    expect(await t.send(bo, "/seat 30 male")).toMatch(/age 30/);
  });

  it("the owner needs no approval, and an approval during a hand seats them after it", async () => {
    const t = await start();
    await t.send(bea, "/seat 40 female"); expect(await t.send(bea, "/seat yes")).toBe("Bea has a seat.");
    sessions.get(KEY)!.snapshots.at(-1)!.game.phase = "flop";
    await t.send(cy, "/seat 41 female"); await t.send(cy, "/seat yes");
    expect(await t.send(bea, "/seat approve Cy")).toMatch(/noted/);
    expect(room().players["u-cy"]).toBeUndefined();
    sessions.get(KEY)!.snapshots.at(-1)!.game.phase = "between";
    await t.send(bea, "/seat list");
    await t.send(bea, "/pay Zed 1"); // any command turn runs the queue
    expect(room().players["u-cy"]).toBeDefined();
  });
});
