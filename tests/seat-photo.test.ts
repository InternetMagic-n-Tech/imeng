import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import sharp from "sharp";
import type { KeyPoint, Person } from "../src/utils/seat-photo.js";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-seat-photo");
process.env.IMAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "seat-photos-"));
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { _resetSeats } = await import("../src/utils/seats.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { SEATING } = await import("../src/utils/config.js");
const P = await import("../src/utils/seat-photo.js");
const { purgePhotos, startCommand } = await import("../src/utils/seating.js");
const { parseCommand } = await import("../src/utils/commands.js");
const { readImage } = await import("../src/utils/image-store.js");

const ollama = makeOllama();
const bea = { id: "u-bea", name: "Bea" }, bo = { id: "u-bo", name: "Bo" }, cy = { id: "u-cy", name: "Cy" };
const TABLE = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", KEY = "chat:" + TABLE;
const settle = async () => { await sessions.get(KEY)?.tail; await flushLogs(); };
const kp = (c: Record<number, number>): KeyPoint[] => Array.from({ length: 17 }, (_, i) => ({ x: 10, y: 10, c: c[i] ?? 0 }));
const FACE: Person = { score: 0.9, keypoints: kp({ 0: 0.9, 1: 0.1, 2: 0.1 }) }; // nose seen, eyes covered: fine
const BODY: Person = { score: 0.9, keypoints: kp({ 5: 0.9, 6: 0.9, 11: 0.9, 12: 0.9 }) };
let png: Buffer;
let unique = 0;
const picture = async (): Promise<string> => { png = await sharp({ create: { width: 8 + (unique++ % 5), height: 8, channels: 3, background: { r: 200, g: 100 + unique, b: 50 } } }).png().toBuffer(); return `data:image/png;base64,${png.toString("base64")}`; };

/** One table, as Open WebUI sends it: the chat so far plus this person's message (optionally with a picture). */
const post = async (log: { role: string; content: unknown }[], who: { id: string; name: string }, text: string, withPicture = false) => {
  log.push({ role: "user", content: withPicture ? [{ type: "text", text }, { type: "image_url", image_url: { url: await picture() } }] : text });
  const res = await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", TABLE).set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", who.name).send({ messages: log });
  const out = res.body?.choices?.[0]?.message?.content as string;
  log.push({ role: "assistant", content: out });
  return out;
};

beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The studio hums.";
  sessions.clear(); _resetSeats(); P.setPoseRunner(null);
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterAll(() => fs.rmSync(process.env.IMAGE_DIR!, { recursive: true, force: true }));

describe("what makes a picture acceptable", () => {
  const o = { threshold: 0.4, keypoint: 0.5, people: 1 };
  it("one person with a nose is a face, even with the eyes covered; shoulders and hips alone are a body", () => {
    expect(P.judgePose([FACE], o)).toEqual({ ok: true, kind: "face" });
    expect(P.judgePose([BODY], o)).toEqual({ ok: true, kind: "body" });
  });
  it("with check.eyes set, a face needs both eyes; a covered eye falls to the body test or unclear", () => {
    const e = { ...o, eyes: 0.4 };
    expect(P.judgePose([{ score: 0.9, keypoints: kp({ 0: 0.9, 1: 0.9, 2: 0.9 }) }], e)).toEqual({ ok: true, kind: "face" });
    expect(P.judgePose([{ score: 0.9, keypoints: kp({ 0: 0.9, 1: 0.1, 2: 0.9 }) }], e)).toEqual({ ok: false, reason: "unclear" });
    expect(P.judgePose([{ score: 0.9, keypoints: kp({ 0: 0.9, 1: 0.1, 2: 0.9, 5: 0.9, 6: 0.9, 11: 0.9, 12: 0.9 }) }], e)).toEqual({ ok: true, kind: "body" });
  });
  it("with faceMin set, a face needs a face box at that score; under it the body test decides", () => {
    const f = { ...o, faceMin: 0.45 };
    expect(P.judgePose([FACE], { ...f, faceScore: 0.8 })).toEqual({ ok: true, kind: "face" });
    expect(P.judgePose([FACE], { ...f, faceScore: 0.44 })).toEqual({ ok: false, reason: "unclear" });
    expect(P.judgePose([FACE], f)).toEqual({ ok: false, reason: "unclear" });
    expect(P.judgePose([{ score: 0.9, keypoints: kp({ 0: 0.9, 5: 0.9, 6: 0.9, 11: 0.9, 12: 0.9 }) }], { ...f, faceScore: 0.2 })).toEqual({ ok: true, kind: "body" });
  });
  it("nobody, two people, or neither a nose nor a torso is refused; a faint detection does not count", () => {
    expect(P.judgePose([], o)).toEqual({ ok: false, reason: "none" });
    expect(P.judgePose([{ ...FACE, score: 0.2 }], o)).toEqual({ ok: false, reason: "none" });
    expect(P.judgePose([FACE, BODY], o)).toEqual({ ok: false, reason: "many" });
    expect(P.judgePose([{ score: 0.9, keypoints: kp({ 5: 0.9, 6: 0.9 }) }], o)).toEqual({ ok: false, reason: "unclear" }); // shoulders only
    expect(P.judgePose([{ score: 0.9, keypoints: [] }], o)).toEqual({ ok: false, reason: "unclear" });
  });
  it("the rules text is the game's markdown file, with {hours} filled; the default when the file is missing", () => {
    expect(P.photoRules()).toContain("Deleted 24 hours later");
    expect(SEATING!.photo!.texts.rules).toContain("{hours}");
  });
});

describe("taking a seat takes a picture", () => {
  it("is configured, and /start is a command", () => {
    expect(SEATING!.photo).toMatchObject({ required: true, keepHours: 24, textFile: "seat-photo.md", check: { people: 1 } });
    expect(SEATING!.start).toMatchObject({ auto: true, early: true });
    expect(parseCommand("/start")).toMatchObject({ name: "start" });
  });
  it("/seat yes sends the rules and waits; a picture with two people or none is refused; one person with a nose gives the seat", async () => {
    const log: any[] = [];
    await post(log, bea, "Let's play"); await settle();
    await post(log, bo, "/seat 30 male");
    expect(await post(log, bo, "/seat yes")).toContain("Send one picture of just you");
    P.setPoseRunner(async () => [FACE, BODY]);
    expect(await post(log, bo, "here you go", true)).toMatch(/more than one person/);
    P.setPoseRunner(async () => []);
    expect(await post(log, bo, "again", true)).toMatch(/cannot see a person/);
    expect(Object.keys(sessions.get(KEY)!.room?.players ?? {})).toEqual([]); // still no seat
    P.setPoseRunner(async () => [FACE]);
    const ok = await post(log, bo, "last try", true);
    expect(ok).toContain("Picture accepted (face)");
    expect(ok).toContain("Bo has a seat");
    const bp = sessions.get(KEY)!.room!.players[bo.id];
    expect(bp.photo).toMatchObject({ kind: "face" });
    expect(readImage(bp.photo!.name)).not.toBeNull(); // stored under its content name, served from /images/<name>
  });
  it("a checker that cannot run fails closed: no seat", async () => {
    const log: any[] = [];
    await post(log, bea, "Let's play"); await settle();
    await post(log, bo, "/seat 30 male"); await post(log, bo, "/seat yes");
    P.setPoseRunner(async () => { throw new Error("model missing"); });
    expect(await post(log, bo, "pic", true)).toMatch(/cannot check pictures/);
    expect(sessions.get(KEY)!.room!.players[bo.id]).toBeUndefined();
  });
  it("a picture from someone with no pending seat is an ordinary message, not a seat picture", async () => {
    const log: any[] = [];
    await post(log, bea, "Let's play"); await settle();
    P.setPoseRunner(async () => { throw new Error("must not be asked"); });
    expect(await post(log, cy, "look at this", true)).toMatch(/watching/);
  });
});

describe("the show starts when the seats are full, or when the owner says so", () => {
  const sit = async (log: any[], who: { id: string; name: string }): Promise<string> => { await post(log, who, "/seat 30 male"); await post(log, who, "/seat yes"); P.setPoseRunner(async () => [FACE]); return post(log, who, "pic", true); };
  it("the owner cannot start early with too few seats; with enough they can, and the table is shown the photos", async () => {
    const log: any[] = [];
    await post(log, bea, "Let's play"); await settle();
    await sit(log, bo);
    expect(await post(log, bea, "/start")).toMatch(/Not enough seats are taken yet \(1 of 2\)/);
    expect(await post(log, bo, "/start")).toMatch(/Only the table owner/);
    await sit(log, cy);
    expect(await post(log, bea, "/start")).toBe("The show is starting.");
    const s = sessions.get(KEY)!;
    expect(s.snapshots.at(-1)!.game.started).toBe(true);
    const shown = (s.own?.notices ?? []).join("\n");
    expect(shown).toMatch(/Here are the contestants/);
    expect(shown).toMatch(/!\[Bo\]\(http[^)]*\/images\/[a-f0-9]{24}\.png\)/);
    expect(shown).toMatch(/!\[Cy\]\(/);
    expect(await post(log, bea, "/start")).toMatch(/already started/);
  });
  it("full seats start the show by themselves", async () => {
    const log: any[] = [];
    await post(log, bea, "Let's play"); await settle();
    await sit(log, bo); await sit(log, cy);
    expect(sessions.get(KEY)!.snapshots.at(-1)!.game.started).toBeUndefined(); // 2 of 3
    await sit(log, bea);
    expect(sessions.get(KEY)!.snapshots.at(-1)!.game.started).toBe(true);
  });
  it("photos are purged after keep_hours: removed from the player and the file deleted", async () => {
    const log: any[] = [];
    await post(log, bea, "Let's play"); await settle();
    await sit(log, bo);
    const s = sessions.get(KEY)!, p = s.room!.players[bo.id], name = p.photo!.name, removed: string[] = [];
    expect(purgePhotos(s, (p.photo!.at ?? 0) + 3_600_000, (n) => removed.push(n))).toBe(0);
    expect(purgePhotos(s, (p.photo!.at ?? 0) + 25 * 3_600_000, (n) => removed.push(n))).toBe(1);
    expect(removed).toEqual([name]);
    expect(p.photo).toBeUndefined();
    expect(await startCommand(s, { userId: "zz", name: "Zed" })).toMatch(/Only the table owner/);
  });
});

describe("the configured model", () => {
  it("with its environment variable unset the real checker cannot run, so it fails closed", async () => {
    P.setPoseRunner(null);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    expect(await P.checkSeatPhoto(png)).toEqual({ ok: false, reason: "down" });
  });
});
