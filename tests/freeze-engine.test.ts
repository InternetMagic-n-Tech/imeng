import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";
import type { Who } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/identity"); // npc mode, public catch-up, anyone may freeze anyone
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { _resetIdentity } = await import("../src/utils/identity.js");
const { flushLogs } = await import("../src/utils/logger.js");

const ollama = makeOllama();
const bea: Who = { id: "u-bea", name: "Bea" }, bo: Who = { id: "u-bo", name: "Bo" }, disc: Who = { id: "discord:77", name: "Dee" };
const KEY = "chat:tbl";
const settle = async () => { await sessions.get(KEY)!.tail; await flushLogs(); };
const narrations = () => ollama.calls("narrator").length;
const system = () => String(ollama.calls("narrator").at(-1)!.body.messages[0].content);
const lastUser = () => String(ollama.calls("narrator").at(-1)!.body.messages.at(-1).content);

const startTable = async () => {
  const t = makeChat(app, "tbl");
  await t.send(bea, "Let's play"); await settle();
  await t.send(bo, "I follow her in");
  return t;
};

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers.";
  sessions.clear(); _resetSeats(); _resetIdentity();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("/freeze and /unfreeze at a table", () => {
  it("a frozen player is not waited for, is not heard, and is played as an NPC meanwhile", async () => {
    const t = await startTable();
    const before = narrations();
    expect(await t.send(bea, "/freeze")).toBe("Bea is frozen.");
    expect(sessions.get(KEY)!.room!.players["u-bea"].frozen).toBe(true);
    expect(sessions.get(KEY)!.frozen!.user).toMatchObject({ kind: "player" });
    expect(await t.send(bea, "I try to speak")).toBe("You are frozen. Send /unfreeze to come back.");
    expect(narrations()).toBe(before);
    ollama.s.narration = "The lock clicks.";
    expect(await t.send(bo, "I pick the lock")).toBe("Waiting for: Bo."); // Bea is not in the wait list
    expect(await t.send(bo, "ready")).toBe("The lock clicks.");
    await settle();
    expect(system()).toContain("## FROZEN (written by the server)\n- Bea is frozen (the player is away): you play Bea yourself as an NPC");
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors.user.controlled_by).toBe("npc");
    expect(sessions.get(KEY)!.snapshots.at(-1)!.game.turn).toBe(2); // the commands and the muted message were never rounds
  });

  it("on return the player reads what everyone saw (not whispers), and the narrator is told once that she knows", async () => {
    const t = await startTable();
    await t.send(bea, "/freeze");
    ollama.s.narration = "Bo finds a secret door.";
    await t.send(bo, "I search"); await t.send(bo, "ready"); await settle();
    const back = await t.send(bea, "/unfreeze");
    expect(back).toBe("Bea is back.\n\nWhile you were away:\n\nBo finds a secret door.");
    expect(sessions.get(KEY)!.room!.players["u-bea"].frozen).toBe(false);
    ollama.s.narration = "Bea steps through.";
    await t.send(bea, "I step through"); await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    expect(system()).toContain("- Bea is back and knows what everyone saw while they were frozen");
    expect(system()).not.toContain("Bea is frozen");
    ollama.s.narration = "Quiet.";
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    expect(system()).not.toContain("is back"); // told once
    expect(sessions.get(KEY)!.snapshots.at(-1)!.actors.user.controlled_by).toBe("user");
  });

  it("anyone may freeze anyone here, NPCs included; names are looked up", async () => {
    const t = await startTable();
    ollama.s.extractor.push([{ op: "add_actor", id: "npc_guard", value: { name: "Guard" } }]);
    ollama.s.narration = "A guard appears.";
    await t.send(bea, "look"); await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    expect(await t.send(bo, "/freeze guard")).toBe("Guard is frozen.");
    expect(sessions.get(KEY)!.frozen!.npc_guard.kind).toBe("npc");
    expect(await t.send(bo, "/freeze Bea")).toBe("Bea is frozen.");
    expect(await t.send(bo, "/freeze Zed")).toBe('I don\'t know who "Zed" is.');
    expect(await t.send(bo, "/unfreeze Bea")).toBe("Bea is back."); // someone else unfroze her: no catch-up is shown to them
    expect(await t.send(bo, "/unfreeze Bo")).toBe("Bo is not frozen.");
    await t.send(bea, "ready"); await t.send(bo, "ready"); await settle();
    expect(system()).toContain("Guard is frozen");
  });

  it("works from the person's private chat at the table, and says when there is no table", async () => {
    const t = await startTable();
    const priv = makeChat(app, "private-bea");
    await priv.send(bea, "hello"); // a new chat of a seated person: their private channel
    expect(await priv.send(bea, "/freeze")).toBe("Bea is frozen.");
    expect(sessions.get(KEY)!.room!.players["u-bea"].frozen).toBe(true);
    void t;
    const solo = makeChat(app, "solo1");
    const cy: Who = { id: "u-cy", name: "Cy" };
    await solo.send(cy, "Let's play");
    expect(await solo.send(cy, "/freeze")).toBe("There is no table here; freeze needs a shared game.");
  });
});

describe("/link across apps", () => {
  it("a Discord code, redeemed in Open WebUI, makes the same player; the table follows", async () => {
    const t = await startTable();
    const lnk = makeChat(app, "lnk");
    const out = await lnk.send(disc, "/link");
    expect(out).toMatch(/^I sent you a link code in a direct message\.<dm>/);
    const code = /send \/link ([A-Z2-9]{8})/.exec(out)![1];
    expect(await t.send(bea, "/link BADBADBA")).toBe("That code is not valid or has expired.");
    expect(await t.send(bea, `/link ${code}`)).toBe("Linked: this account and Dee are now the same player.");
    expect(narrations()).toBe(1); // none of it reached the narrator
    await t.send(disc, "I wave"); // she speaks from Discord now
    const room = sessions.get(KEY)!.room!;
    expect(room.order).toEqual(["discord:77", "u-bo"]);
    expect(room.players["discord:77"].actor).toBe("user");
  });
});
