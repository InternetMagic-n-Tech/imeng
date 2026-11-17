import { describe, it, expect, jest } from "@jest/globals";
import path from "node:path";
import { PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
const { loadReference, isPrivateIp } = await import("../src/utils/image-ref.js");
const ok = (bytes: Buffer, headers: Record<string, string> = {}) => jest.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers })) as unknown as typeof fetch;

describe("reference images", () => {
  it("reads a file in the game folder, and never one outside it", async () => {
    expect((await loadReference("ref.png")).kind).toBe("png");
    await expect(loadReference("../../package.json")).rejects.toThrow("outside the game folder");
  });
  it("reads a picture attached as a data URI and refuses an unusable one", async () => {
    expect((await loadReference("data:image/png;base64," + PNG.toString("base64"))).bytes).toEqual(PNG);
    await expect(loadReference("data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"))).rejects.toThrow("svg");
    await expect(loadReference("data:application/pdf;base64," + Buffer.from("%PDF-1.4 x").toString("base64"))).rejects.toThrow("pdf");
  });
  it("fetches a URL only when the game allows it, and never from a private address", async () => {
    await expect(loadReference("https://x.example/a.png", { fetch: ok(PNG) })).rejects.toThrow("not allowed");
    const lookup = async () => ["93.184.216.34"];
    expect((await loadReference("https://x.example/a.png", { fetch: ok(PNG), allowUrls: true, lookup })).kind).toBe("png");
    await expect(loadReference("https://x.example/a.png", { fetch: ok(PNG), allowUrls: true, lookup: async () => ["10.0.0.5"] })).rejects.toThrow("private");
    await expect(loadReference("http://127.0.0.1/a.png", { fetch: ok(PNG), allowUrls: true })).rejects.toThrow("private");
    expect((await loadReference("http://127.0.0.1/a.png", { fetch: ok(PNG), allowUrls: true, allowPrivate: true })).kind).toBe("png");
  });
  it("refuses a URL that answers badly, is too big, or is not a picture", async () => {
    const lookup = async () => ["93.184.216.34"];
    await expect(loadReference("https://x.example/a", { fetch: jest.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch, allowUrls: true, lookup })).rejects.toThrow("404");
    await expect(loadReference("https://x.example/a", { fetch: ok(PNG, { "content-length": "99999999" }), allowUrls: true, lookup })).rejects.toThrow("too_big");
    await expect(loadReference("https://x.example/a", { fetch: ok(Buffer.from("<svg/>")), allowUrls: true, lookup })).rejects.toThrow("svg");
  });
  it("knows private addresses", () => {
    for (const ip of ["10.1.1.1", "127.0.0.1", "192.168.0.2", "172.20.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateIp(ip)).toBe(false);
  });
});
