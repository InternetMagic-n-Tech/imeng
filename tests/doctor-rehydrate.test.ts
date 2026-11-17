import { describe, it, expect } from "@jest/globals";
import { runDoctor } from "../src/utils/doctor.js";
import { makeSettings, makeSys } from "./fake-sys.js";

const run = async (game: Record<string, unknown>, databaseUrl = "postgres://x") =>
  (await runDoctor(makeSys({}), makeSettings({ game: game as never, databaseUrl } as never))).findings.filter((x) => /^(rehydrate|eligibility|pii-filter)-/.test(x.id));
const level = (fs: { id: string; level: string }[], id: string) => fs.find((x) => x.id === id)?.level;
const detail = (fs: { id: string; detail?: string }[], id: string) => fs.find((x) => x.id === id)?.detail ?? "";

describe("doctor: rehydrate and eligibility", () => {
  it("says nothing without the blocks", async () => { expect(await run({})).toEqual([]); });
  it("accepts good blocks", async () => {
    const f = await run({ rehydrate: { paths: ["actors.*.chips"], notes: { "actors.*.chips": "x" } }, eligibility: { flags: ["opted_in", "busted"], join: { require: ["opted_in"], block: ["busted"] }, opt_in: "opted_in", rules: [{ flag: "busted", path: "actors.*.chips", op: "<=", value: 0 }] } });
    expect(level(f, "rehydrate-config")).toBe("ok");
    expect(level(f, "eligibility-config")).toBe("ok");
  });
  it("a server-dealt or server-betting game fails the doctor without DATABASE_URL", async () => {
    const only = async (g: Record<string, unknown>, url: string) => (await runDoctor(makeSys({}), makeSettings({ game: g as never, databaseUrl: url } as never))).findings.find((x) => x.id === "server-deal-db")?.level;
    expect(await only({ deal: "server" }, "")).toBe("fail");
    expect(await only({ betting: "server" }, "")).toBe("fail");
    expect(await only({ deal: "server" }, "postgres://x")).toBeUndefined();
    expect(await only({}, "")).toBeUndefined();
  });
  it("fails without DATABASE_URL", async () => { expect(level(await run({ rehydrate: { paths: ["actors.*.chips"] } }, ""), "rehydrate-db")).toBe("fail"); });
  it("fails bad paths, personal paths and orphan notes", async () => {
    const f = await run({ pii: ["actors.*.real_name"], rehydrate: { paths: ["game.x", "actors.*.real_name"], notes: { "actors.*.nope": "x" } } });
    expect(level(f, "rehydrate-config")).toBe("fail");
    expect(detail(f, "rehydrate-config")).toMatch(/actors\.\*\.<field>.*game\.x.*marked personal.*real_name/);
    expect(level(f, "rehydrate-notes")).toBe("warn");
  });
  it("fails bad flag sets", async () => {
    const f = await run({ eligibility: { flags: ["a", "a", "Bad"], join: { require: ["zzz"] }, rules: [{ flag: "a", path: "game.x", op: "==" }] } });
    expect(detail(f, "eligibility-config")).toMatch(/duplicate.*a-z.*unknown flags used: zzz.*rule paths/);
    expect(level(await run({ eligibility: { flags: [] } }), "eligibility-config")).toBe("fail");
    expect(level(await run({ eligibility: { flags: Array.from({ length: 32 }, (_, i) => `f${i}`) } }), "eligibility-config")).toBe("fail");
  });
  it("checks the pii_filter patterns and warns about a missing salt", async () => {
    const f = await run({ pii_filter: { patterns: [{ name: "Bad Name", regex: "(" }] } });
    expect(level(f, "pii-filter-config")).toBe("fail");
    expect(level(f, "pii-filter-salt")).toBe("warn");
    expect(level(await run({ pii_filter: { patterns: [{ name: "room", regex: "room \\d+" }] } }), "pii-filter-config")).toBe("ok");
  });
  it("tells you when nobody can set the required flags", async () => {
    expect(level(await run({ eligibility: { flags: ["a"], join: { require: ["a"] } } }), "eligibility-optin")).toBe("info");
  });
});
