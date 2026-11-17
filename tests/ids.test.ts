import { describe, it, expect, afterEach } from "@jest/globals";
import crypto from "node:crypto";
import { mintId, setIdSource, alphabetOf } from "../src/utils/ids.js";
import type { Mint } from "../src/utils/types.js";

afterEach(() => setIdSource());
const mint = (m: Mint, fields: Record<string, unknown> = { name: "Rusty Key" }, ids: string[] = []) => mintId(m, { fields, from: "name", ids });
const fixedBytes = (b: number) => (n: number) => Buffer.alloc(n, b);

describe("mintId", () => {
  it("uuid 4: a random v4 UUID", () => {
    expect(mint({ kind: "uuid" })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("uuid 7: time first, version 7", () => {
    setIdSource({ now: () => 0x0123456789ab, bytes: fixedBytes(0xff) });
    expect(mint({ kind: "uuid", version: 7 })).toBe("01234567-89ab-7fff-bfff-ffffffffffff");
  });

  it("uuid 5: the standard answer for a name in the DNS namespace, and the same name gives the same id", () => {
    expect(mint({ kind: "uuid", version: 5 }, { name: "python.org" })).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    expect(mint({ kind: "uuid", version: 5 }, { name: "  Python.ORG " })).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    expect(() => mint({ kind: "uuid", version: 5 }, {})).toThrow("needs the field");
    expect(() => mint({ kind: "uuid", version: 6 as 7 })).toThrow("not supported");
  });

  it("random: length and alphabet, custom characters, no bias towards the first characters", () => {
    expect(mint({ kind: "random" })).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(mint({ kind: "random", alphabet: "digits", length: 12 })).toMatch(/^\d{12}$/);
    expect(mint({ kind: "random", alphabet: "ab", length: 30 })).toMatch(/^[ab]{30}$/);
    expect(mint({ kind: "random", alphabet: "hex", length: 100 }).length).toBe(64); // capped
    expect(() => alphabetOf("a")).toThrow("at least 2");
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const c of mint({ kind: "random", alphabet: "abc", length: 10 })) seen.add(c);
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });

  it("number: an integer in the range", () => {
    for (let i = 0; i < 200; i++) { const n = Number(mint({ kind: "number", min: 5, max: 7 })); expect([5, 6, 7]).toContain(n); }
    expect(() => mint({ kind: "number", min: 3, max: 1 })).toThrow("min <= max");
  });

  it("counter: one more than the highest number after the prefix, padded", () => {
    expect(mint({ kind: "counter", prefix: "item_" }, {}, [])).toBe("item_1");
    expect(mint({ kind: "counter", prefix: "item_", pad: 3 }, {}, ["item_007", "item_2", "other_99", "item_x"])).toBe("item_008");
  });

  it("timestamp: formats, none with a dot or a colon", () => {
    setIdSource({ now: () => Date.UTC(2026, 10, 12, 9, 8, 7, 6) });
    expect(mint({ kind: "timestamp" })).toBe(String(Date.UTC(2026, 10, 12, 9, 8, 7, 6)));
    expect(mint({ kind: "timestamp", format: "epoch_s", prefix: "t" })).toBe(`t${Math.floor(Date.UTC(2026, 10, 12, 9, 8, 7, 6) / 1000)}`);
    expect(mint({ kind: "timestamp", format: "compact" })).toBe("20261112090807006");
    expect(mint({ kind: "timestamp", format: "iso" })).toBe("2026-11-12T09-08-07-006Z");
  });

  it("hash: of the field (case and spacing ignored), algorithm, length and prefix", () => {
    const sha = crypto.createHash("sha256").update("rusty key").digest("hex");
    expect(mint({ kind: "hash" })).toBe(sha);
    expect(mint({ kind: "hash" }, { name: "  RUSTY   key " })).toBe(sha);
    expect(mint({ kind: "hash", algo: "md5", length: 8, prefix: "k_" })).toBe("k_" + crypto.createHash("md5").update("rusty key").digest("hex").slice(0, 8));
    expect(mint({ kind: "hash", of: "tag" }, { name: "x", tag: "T" })).toBe(crypto.createHash("sha256").update("t").digest("hex"));
    expect(() => mint({ kind: "hash" }, { name: "" })).not.toThrow(); // an empty name still hashes
    expect(() => mint({ kind: "hash" }, {})).toThrow("needs the field");
  });

  it("never returns an id that is taken: random is drawn again, the same answer gets -2, -3", () => {
    let n = 0;
    setIdSource({ bytes: (len) => Buffer.alloc(len, n++ < 8 ? 0 : 1) }); // the first 8 draws are all "0..."
    const first = mint({ kind: "random", alphabet: "digits", length: 3 }, {}, ["000"]);
    expect(first).not.toBe("000");
    setIdSource({ bytes: fixedBytes(0) });
    expect(mint({ kind: "random", alphabet: "digits", length: 3 }, {}, ["000"])).toBe("000-2");
    expect(mint({ kind: "random", alphabet: "digits", length: 3 }, {}, ["000", "000-2"])).toBe("000-3");
    expect(mint({ kind: "hash" }, { name: "A" }, [crypto.createHash("sha256").update("a").digest("hex")])).toMatch(/-2$/);
  });
});
