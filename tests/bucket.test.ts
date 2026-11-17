import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Readable } from "node:stream";

const B = await import("../src/utils/bucket.js");

const fake = () => {
  const store = new Map<string, Buffer>();
  const made: string[] = [];
  return {
    store, made,
    bucketExists: async () => made.length > 0,
    makeBucket: async (n: string) => { made.push(n); },
    putObject: async (_b: string, k: string, d: Buffer) => { store.set(k, d); },
    getObject: async (_b: string, k: string) => { if (!store.has(k)) throw new Error("NoSuchKey"); return Readable.from([store.get(k)!]); },
  };
};

describe("bucket", () => {
  beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); });

  it("is off with no client", async () => {
    B._useClient(null);
    expect(B.bucketOn()).toBe(false);
    expect(await B.bucketPut("a", Buffer.from("x"))).toBe(false);
    expect(await B.bucketGet("a")).toBeNull();
  });

  it("creates the bucket once, then keeps and returns files", async () => {
    const f = fake();
    B._useClient(f);
    expect(await B.bucketPut("images/a.png", Buffer.from("hello"), "image/png")).toBe(true);
    expect(await B.bucketPut("images/b.png", Buffer.from("x"))).toBe(true);
    expect(f.made).toEqual(["proxy-files"]);
    expect((await B.bucketGet("images/a.png"))?.toString()).toBe("hello");
    expect(await B.bucketGet("images/none.png")).toBeNull();
  });

  it("never throws when the bucket is down", async () => {
    B._useClient({ ...fake(), bucketExists: async () => { throw new Error("connection refused"); } });
    expect(await B.bucketReady()).toBe(false);
    expect(await B.bucketPut("a", Buffer.from("x"))).toBe(false);
  });
});
