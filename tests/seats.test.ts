import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeFakeRedis } from "./fake-redis.js";

const fake = Object.assign(makeFakeRedis(), {
  hash: {} as Record<string, string>,
  hSet: jest.fn(async (_k: string, f: string, v: string) => { fake.hash[f] = v; return 1; }),
  hGetAll: jest.fn(async (_k: string) => ({ ...fake.hash })),
  hDel: jest.fn(async (_k: string, f: string) => { delete fake.hash[f]; return 1; }),
});
let client: typeof fake | null = fake;
jest.unstable_mockModule("../src/utils/logger.js", () => ({ redisClient: () => client }));

const { seats, seat, seatOf, unseat, loadSeats, _resetSeats } = await import("../src/utils/seats.js");
const { SESSION_PREFIX } = await import("../src/utils/config.js");
const file = () => path.join(process.env.SAVE_DIR!, "seats.json");
const DAY = 86_400_000;

beforeEach(() => {
  _resetSeats(); fake.hash = {}; client = fake;
  for (const f of [fake.hSet, fake.hGetAll, fake.hDel]) f.mockClear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("seats", () => {
  it("speaking at a table gives a seat: kept in memory, in the file and in Redis", async () => {
    await seat("u1", "chat:t", 1000);
    expect(seats.get("u1")).toEqual({ table: "chat:t", at: 1000 });
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual({ u1: { table: "chat:t", at: 1000 } });
    expect(fake.hSet).toHaveBeenCalledWith(`${SESSION_PREFIX}:seats`, "u1", JSON.stringify({ table: "chat:t", at: 1000 }));
  });

  it("the same seat is not rewritten every message, but moves to another table at once and is refreshed hourly", async () => {
    await seat("u1", "chat:t", 0);
    await seat("u1", "chat:t", 60_000);
    expect(fake.hSet).toHaveBeenCalledTimes(1);
    await seat("u1", "chat:other", 61_000);
    expect(fake.hSet).toHaveBeenCalledTimes(2);
    await seat("u1", "chat:other", 61_000 + 3_700_000);
    expect(fake.hSet).toHaveBeenCalledTimes(3);
  });

  it("seatOf: the table, until the seat has not been used for the allowed time", async () => {
    await seat("u1", "chat:t", 0);
    expect(seatOf("u1", 13 * DAY, 14 * DAY)).toBe("chat:t");
    expect(seatOf("u1", 15 * DAY, 14 * DAY)).toBeNull();
    expect(seatOf("nobody", 0, 14 * DAY)).toBeNull();
  });

  it("unseat removes it everywhere, and does nothing for someone who has no seat", async () => {
    await seat("u1", "chat:t", 0);
    await unseat("u1");
    expect(seats.has("u1")).toBe(false);
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual({});
    expect(fake.hDel).toHaveBeenCalledWith(`${SESSION_PREFIX}:seats`, "u1");
    await unseat("u1");
    expect(fake.hDel).toHaveBeenCalledTimes(1);
  });

  it("a restart (or another container) reads the file and Redis once; a damaged entry is skipped", async () => {
    await seat("u1", "chat:t", 5);
    _resetSeats();
    fake.hash.u2 = JSON.stringify({ table: "chat:t", at: 9 });
    fake.hash.bad = "{not json";
    fake.hash.worse = JSON.stringify({ table: 7 });
    await loadSeats(); await loadSeats();
    expect(Object.fromEntries(seats)).toEqual({ u1: { table: "chat:t", at: 5 }, u2: { table: "chat:t", at: 9 } });
    expect(fake.hGetAll).toHaveBeenCalledTimes(1);
  });

  it("without Redis it still works from the file; a Redis error is reported and ignored", async () => {
    client = null;
    await seat("u1", "chat:t", 1);
    expect(fs.existsSync(file())).toBe(true);
    client = fake;
    fake.hSet.mockRejectedValueOnce(new Error("down"));
    await expect(seat("u2", "chat:t", 1)).resolves.toBeUndefined();
    expect(seats.get("u2")).toBeDefined();
  });
});
