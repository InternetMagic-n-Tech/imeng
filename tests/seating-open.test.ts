import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-seating-open");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { SEATING } = await import("../src/utils/config.js");
const { parseCommand } = await import("../src/utils/commands.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" }, cy = { id: "u-cy", name: "Cy" };
const TABLE = "dddddddd-4444-4444-8444-dddddddddddd", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)?.tail; await flushLogs(); };

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The cards are out.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});

describe("seating without owner approval", () => {
  it("is configured with an age floor of 18 or more, and /seat is a command", () => {
    expect(SEATING).toMatchObject({ phases: ["between"], minAge: 21, defaultSexuality: "straight" });
    expect(parseCommand("/seat 30 female")).toMatchObject({ name: "seat", arg: "30 female" });
  });

  it("someone without a seat watches; /seat, then /seat yes, gives a seat with the profile", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    const calls = ollama.calls("narrator").length;
    expect(await t.send(bo, "hello all")).toMatch(/watching/);
    expect(await t.send(bo, "/seat")).toMatch(/\/seat <age>/);
    expect(await t.send(bo, "/seat 20 male")).toMatch(/21 or older/);
    expect(await t.send(bo, "/seat 30 robot")).toMatch(/Say one of: female, male, nonbinary/);
    expect(await t.send(bo, "/seat yes")).toMatch(/Say \/seat/);
    expect(await t.send(bo, "/seat 30 male")).toMatch(/age 30, male, straight/);
    expect(await t.send(bo, "/seat yes")).toBe("Bo has a seat.");
    expect(await t.send(bo, "/seat 30 male")).toMatch(/already/);
    const a = sessions.get(KEY)!.snapshots.at(-1)!.actors;
    const mine = Object.values(a).find((x: any) => x.name === "Bo") as any;
    expect(mine).toMatchObject({ age: 30, gender: "male", sexuality: "straight", controlled_by: "user" }); // the first seat is actors.user (the launcher is not seated either: everyone uses /seat)
    expect(ollama.calls("narrator")).toHaveLength(calls);
  });

  it("a round after seating keeps what /seat and the commands did (the chat became a table at the first seat)", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "/seat 30 male"); await t.send(bo, "/seat yes");
    expect(sessions.get(KEY)!.room!.rounds).toBe(1);
    expect(sessions.get(KEY)!.room!.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    const calls = ollama.calls("narrator").length;
    await t.send(bo, "I look around the room"); await settle();
    expect(ollama.calls("narrator").length).toBeGreaterThan(calls);
    const mine = Object.values(sessions.get(KEY)!.snapshots.at(-1)!.actors).find((x: any) => x.name === "Bo") as any;
    expect(mine).toMatchObject({ age: 30, gender: "male", sexuality: "straight" });
  });

  it("a yes during a hand is queued, and the person is seated once the phase allows", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    sessions.get(KEY)!.snapshots.at(-1)!.game.phase = "flop";
    await t.send(cy, "/seat 40 female bi");
    expect(await t.send(cy, "/seat yes")).toMatch(/noted/);
    expect(sessions.get(KEY)!.room!.seatQueue).toHaveLength(1);
    expect(sessions.get(KEY)!.room!.players["u-cy"]).toBeUndefined();
    sessions.get(KEY)!.snapshots.at(-1)!.game.phase = "between";
    await t.send(bea, "/seat 33 female"); // any command turn runs the queue
    expect(sessions.get(KEY)!.room!.players["u-cy"]).toBeDefined();
    expect(sessions.get(KEY)!.room!.seatQueue).toEqual([]);
    const cyActor = Object.values(sessions.get(KEY)!.snapshots.at(-1)!.actors).find((x: any) => x.name === "Cy") as any;
    expect(cyActor).toMatchObject({ age: 40, gender: "female", sexuality: "bi" });
  });

  it("the table's own minimum age (game.min_age) raises the floor", async () => {
    const t = makeChat(app, TABLE);
    await t.send(bea, "Let's play"); await settle();
    sessions.get(KEY)!.snapshots.at(-1)!.game.min_age = 35;
    expect(await t.send(bo, "/seat 30 male")).toMatch(/35 or older/);
  });
});
