import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-credit");
process.env.PROXY_API_KEY = "sekret-key-for-test";
const { app } = await import("../src/app.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { startState, stopState, stateDb } = await import("../src/utils/db-state.js");
const { issueCode } = await import("../src/utils/credit.js");

beforeEach(async () => {
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {});
  const file = `sqlite:${process.env.SAVE_DIR}/c.sqlite`;
  await dbMain([], file, () => {});
  await startState(file, { exit: () => {} });
});
afterEach(async () => { await stopState(); jest.restoreAllMocks(); });
const post = (body: unknown) => request(app).post("/admin/credit").set("Authorization", "Bearer sekret-key-for-test").send(body as object);

describe("POST /admin/credit keeps to the registered terms", () => {
  it("refuses a payment for the wrong amount or currency, and credit in another currency, a fraction, or too much", async () => {
    const code = await issueCode(stateDb()!, { game: "mp-credit", userId: "u1", thread: "t", ttlMs: 86_400_000, price: 300, currency: "chips" });
    expect((await post({ paid_code: code, amount: 300, currency: "eur" })).status).toBe(409);
    expect((await post({ paid_code: code, amount: 10, currency: "chips" })).status).toBe(409);
    expect((await post({ paid_code: code, amount: 300, currency: "chips" })).body).toEqual({ ok: true });
    expect((await post({ user_id: "u1", credit: 50, currency: "eur" })).status).toBe(409);
    expect((await post({ user_id: "u1", credit: 2.5 })).status).toBe(400);
    expect((await post({ user_id: "u1", credit: 100001 })).status).toBe(409);
    expect((await post({ user_id: "u1", credit: 50, currency: "chips" })).body).toMatchObject({ ok: true, credit: 50 });
  });
});
