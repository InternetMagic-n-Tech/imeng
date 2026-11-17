import { describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import { requireApiKey, safeEqual } from "../src/utils/auth.js";

const appWith = (key: string) => {
  const a = express();
  a.get("/secret", requireApiKey(key), (_req, res) => { res.json({ ok: true }); });
  return a;
};

describe("safeEqual", () => {
  it("matches equal strings and rejects different ones, whatever their length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("requireApiKey", () => {
  it("lets everything through when no key is configured", async () => {
    expect((await request(appWith("")).get("/secret")).status).toBe(200);
  });

  it("accepts the right bearer token (any case, extra spaces)", async () => {
    const a = appWith("s3cret");
    expect((await request(a).get("/secret").set("Authorization", "Bearer s3cret")).status).toBe(200);
    expect((await request(a).get("/secret").set("Authorization", "bearer   s3cret ")).status).toBe(200);
  });

  it("rejects missing, wrong and non-bearer credentials with 401", async () => {
    const a = appWith("s3cret");
    for (const header of [undefined, "Bearer nope", "Bearer ", "Basic czNjcmV0", "s3cret"]) {
      const r = request(a).get("/secret");
      if (header !== undefined) r.set("Authorization", header);
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/api key/i);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    }
  });
});
