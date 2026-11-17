import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { sessions, saveSession, loadSessions, sessionFor, _resetSessionWarnings } from "../src/utils/sessions.js";
import { initialState } from "../src/utils/state.js";
import type { ChatMessage, Session } from "../src/utils/types.js";

const SAVE_DIR = process.env.SAVE_DIR!;
const req = (headers: Record<string, string> = {}) => ({ get: (n: string) => headers[n.toLowerCase()] });
const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

beforeEach(() => {
  sessions.clear();
  fs.rmSync(SAVE_DIR, { recursive: true, force: true });
  _resetSessionWarnings();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

describe("persistence", () => {
  const sample = (): Session => ({ snapshots: [initialState()], unsynced: [{ user: "u", narration: "n" }], mode: "game", tail: Promise.resolve() });

  it("saves and reloads a session", () => {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    saveSession("chat:1", sample());
    expect(fs.readdirSync(SAVE_DIR).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(fs.readdirSync(SAVE_DIR).some((f) => f.endsWith(".tmp"))).toBe(false);

    sessions.clear();
    loadSessions();
    const s = sessions.get("chat:1")!;
    expect(s.mode).toBe("game");
    expect(s.unsynced).toEqual([{ user: "u", narration: "n" }]);
    expect(s.snapshots[0].actors.user.name).toBe("you");
  });

  it("keeps what a restart must not forget: private offers, who was told a re-entry code, the cards' audit log, peeks and the hand log id", () => {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    const s = sample();
    s.announcements = [{ id: "tip-1", kind: "tip", to: "u1", text: "Do you want to tip?", at: 1 }];
    s.credit = { told: { u2: true } }; s.cardLog = ["hand 1: board set aside"]; s.guesses = { u1: { hand: 2, n: 1 } }; s.viewers = { u3: 4 }; s.peeks = { u1: { hand: 2, target: "u2" } }; s.signals = ["move-1"]; s.logId = "log-1";
    saveSession("chat:keep", s);
    sessions.clear(); loadSessions();
    const r = sessions.get("chat:keep")!;
    expect([r.announcements, r.credit, r.cardLog, r.guesses, r.viewers, r.peeks, r.signals, r.logId]).toEqual([s.announcements, s.credit, s.cardLog, s.guesses, s.viewers, s.peeks, s.signals, "log-1"]);
  });

  it("creates the save dir when loading and skips corrupt files", () => {
    loadSessions();
    expect(fs.existsSync(SAVE_DIR)).toBe(true);
    fs.writeFileSync(path.join(SAVE_DIR, "bad.json"), "{not json");
    loadSessions();
    expect(sessions.size).toBe(0);
    expect(console.warn).toHaveBeenCalledWith("skipping bad save", "bad.json", expect.any(String));
  });

  it("defaults unsynced to [] for saves without it", () => {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(SAVE_DIR, "old.json"), JSON.stringify({ key: "chat:old", snapshots: [initialState()] }));
    loadSessions();
    expect(sessions.get("chat:old")!.unsynced).toEqual([]);
  });
});

describe("sessionFor with the chat-id header", () => {
  it("gives each chat its own fresh session and reuses it", () => {
    const [k1, s1] = sessionFor(req({ "x-openwebui-chat-id": "A" }), [u("hi")]);
    const [k2, s2] = sessionFor(req({ "x-openwebui-chat-id": "B" }), [u("hi")]);
    const [, s1again] = sessionFor(req({ "x-openwebui-chat-id": "A" }), [u("hi"), a("x"), u("more")]);
    expect(k1).toBe("chat:A");
    expect(k2).toBe("chat:B");
    expect(s1).not.toBe(s2);
    expect(s1again).toBe(s1);
    expect(s1.snapshots[0]).not.toBe(s2.snapshots[0]);
  });

  it("returns no promote function", () => {
    expect(sessionFor(req({ "x-openwebui-chat-id": "A" }), [u("hi")])[2]).toBeNull();
  });

  it("tells the caller whether it just created the session (the caller decides about warning)", () => {
    const first = sessionFor(req({ "x-openwebui-chat-id": "Z" }), [u("1"), a("r"), u("2")]);
    expect(first[3]).toBe(true);
    expect(sessionFor(req({ "x-openwebui-chat-id": "Z" }), [u("1"), a("r"), u("2")])[3]).toBe(false);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("No saved game")); // not its job any more
  });
});

describe("sessionFor fallback (no header)", () => {
  it("warns once about the missing header", () => {
    sessionFor(req(), [u("x")]);
    sessionFor(req(), [u("y")]);
    const header = (console.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes("X-OpenWebUI-Chat-Id"));
    expect(header).toHaveLength(1);
  });

  it("first turn is always fresh, even when the opener repeats", () => {
    const [, s1, p1] = sessionFor(req(), [u("Play")]);
    s1.snapshots[0].actors.user.hp = 1;
    const [, s2] = sessionFor(req(), [u("Play")]);
    expect(s2).not.toBe(s1);
    expect(s2.snapshots[0].actors.user.hp).toBe(10);
    expect(p1).toBeInstanceOf(Function);
  });

  it("promote() re-keys the session by the reply, so the next turn finds it", () => {
    const [, s1, promote] = sessionFor(req(), [u("Play")]);
    const key = promote!("The narrator answers");
    expect(key.startsWith("hash:")).toBe(true);
    const [k2, s2] = sessionFor(req(), [u("Play"), a("The narrator answers"), u("go on")]);
    expect(k2).toBe(key);
    expect(s2).toBe(s1);
  });

  it("interleaved chats with the same opener do not cross", () => {
    const [, sA, promoteA] = sessionFor(req(), [u("Play")]);
    const [, sB, promoteB] = sessionFor(req(), [u("Play")]); // second chat starts before the first replied
    const kA = promoteA!("Reply A");
    const kB = promoteB!("Reply B");
    expect(kA).not.toBe(kB);
    expect(sessionFor(req(), [u("Play"), a("Reply A"), u("2")])[1]).toBe(sA);
    expect(sessionFor(req(), [u("Play"), a("Reply B"), u("2")])[1]).toBe(sB);
  });

  it("promote does not drop a newer pending session for the same opener", () => {
    const [, , promote1] = sessionFor(req(), [u("Play")]);
    const [, s2] = sessionFor(req(), [u("Play")]); // replaces the pending entry
    promote1!("one");
    expect(sessions.get([...sessions.keys()].find((k) => k.startsWith("pending:"))!)).toBe(s2);
  });

  it("promotes a leftover pending session when the reply key is unknown", () => {
    const [, pending] = sessionFor(req(), [u("Play")]);
    const [key, s] = sessionFor(req(), [u("Play"), a("Late reply"), u("2")]);
    expect(key.startsWith("hash:")).toBe(true);
    expect(s).toBe(pending);
    expect([...sessions.keys()].some((k) => k.startsWith("pending:"))).toBe(false);
  });

  it("separates users by the user-id header", () => {
    const [k1] = sessionFor(req({ "x-openwebui-user-id": "u1" }), [u("Play"), a("r"), u("2")]);
    const [k2] = sessionFor(req({ "x-openwebui-user-id": "u2" }), [u("Play"), a("r"), u("2")]);
    expect(k1).not.toBe(k2);
  });

  it("removes the pending save file when a session is promoted", () => {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    const [, s, promote] = sessionFor(req(), [u("Play")]);
    const pendingKey = [...sessions.keys()].find((k) => k.startsWith("pending:"))!;
    saveSession(pendingKey, s);
    expect(fs.readdirSync(SAVE_DIR)).toHaveLength(1);
    promote!("reply");
    expect(fs.readdirSync(SAVE_DIR)).toHaveLength(0);
  });
});
