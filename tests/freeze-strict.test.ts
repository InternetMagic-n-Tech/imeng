import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";
import type { Who } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/identity-strict"); // skip mode, no catch-up, only yourself
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" };
const KEY = "chat:tbl";
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };
const system = () => String(ollama.calls("narrator").at(-1)!.body.messages[0].content);

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("freeze with the strict settings", () => {
  it("only yourself, the game's own wording for the narrator, and a return that knows nothing", async () => {
    const t = makeChat(app, "tbl");
    await t.send(bea, "Let's play"); await settle();
    await t.send(bo, "I follow her in");
    expect(await t.send(bo, "/freeze Bea")).toBe("You can only freeze yourself.");
    expect(await t.send(bea, "/freeze")).toBe("Bea is frozen.");
    ollama.s.narration = "Bo explores.";
    await t.send(bo, "I explore"); await t.send(bo, "ready"); await settle();
    expect(system()).toContain("- Bea is out of the room.");
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors.user.controlled_by).toBe("user"); // skip mode: no NPC takeover
    expect(await t.send(bea, "/unfreeze")).toBe("Bea is back."); // catch_up none: nothing shown
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    expect(system()).toContain("Bea is back and does not know what happened while they were frozen.");
  });
});
