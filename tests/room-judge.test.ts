import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import { jsonResponse, mockFetch } from "./helpers.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/multiplayer");

const { judgeMessage, needsJudge } = await import("../src/utils/room-judge.js");
const { newRoom, join } = await import("../src/utils/multiplayer.js");
const { MULTIPLAYER } = await import("../src/utils/config.js");

const cfg = MULTIPLAYER!; // clock: game.minutes, unit minute
const judgeSays = (payload: unknown) => mockFetch(() => jsonResponse({ message: { content: JSON.stringify(payload) } }));
const duo = () => { const r = newRoom(); join(r, { userId: "a", name: "Bea" }, cfg, 0); join(r, { userId: "b", name: "Bo" }, cfg, 0); return r; };
const args = (room: ReturnType<typeof duo>, text = "hi", secret = "") => ({ text, secret, narration: "The crane swings.", me: room.players.b });

beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "log").mockImplementation(() => {}); });

describe("needsJudge", () => {
  it("only at a table of two or more, and never when the game turns the judge off", () => {
    const solo = newRoom(); join(solo, { userId: "a", name: "Bea" }, cfg, 0);
    expect(needsJudge(solo, cfg)).toBe(false);
    expect(needsJudge(duo(), cfg)).toBe(true);
    expect(needsJudge(duo(), { ...cfg, judge: false })).toBe(false);
  });
});

describe("judgeMessage", () => {
  it("returns the kind, who the story waits on (known names only) and a standing instruction with its times read", async () => {
    const f = judgeSays({ kind: "hold", awaiting: ["bea", "Nobody"], standing: { after_real: "5 days", after_game: "2 hours", action: "  wings   it " }, cancel_standing: false });
    const v = await judgeMessage(duo(), cfg, args(duo(), "radio check", "if I vanish, carry on"));
    expect(v).toEqual({ kind: "hold", awaiting: ["bea"], standing: { afterRealMs: 5 * 86_400_000, afterGame: 120, action: "wings it" }, cancelStanding: false });
    const sent = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body)).messages[1].content as string;
    expect(sent).toContain("SPEAKER: Bo");
    expect(sent).toContain("The crane swings.");
    expect(sent).toContain("<private_message>if I vanish, carry on</private_message>");
  });

  it("a standing instruction without a usable time or action is dropped; cancel is passed on", async () => {
    judgeSays({ kind: "act", standing: { after_real: "soon", after_game: null, action: "wings it" }, cancel_standing: true });
    expect(await judgeMessage(duo(), cfg, args(duo()))).toEqual({ kind: "act", awaiting: undefined, standing: null, cancelStanding: true });
    judgeSays({ kind: "act", standing: { after_real: "1 day", action: "" } });
    expect((await judgeMessage(duo(), cfg, args(duo())))!.standing).toBeNull();
  });

  it("nonsense, an unknown kind, an error or a down judge all mean: no verdict", async () => {
    for (const answer of [{ kind: "explode" }, { nothing: 1 }, "text", null]) { judgeSays(answer); expect(await judgeMessage(duo(), cfg, args(duo()))).toBeNull(); }
    mockFetch(() => jsonResponse({ error: "model not found" }));
    expect(await judgeMessage(duo(), cfg, args(duo()))).toBeNull();
    mockFetch(() => { throw new TypeError("fetch failed"); });
    expect(await judgeMessage(duo(), cfg, args(duo()))).toBeNull();
  });

  it("the turn rule of the game goes to the judge", async () => {
    const f = judgeSays({ kind: "act" });
    await judgeMessage(duo(), { ...cfg, turns: "judged", turnRule: "Only the crane operator reacts to radio calls." }, args(duo()));
    expect(String((f.mock.calls[0] as [string, RequestInit])[1].body)).toContain("Only the crane operator reacts to radio calls.");
  });
});
