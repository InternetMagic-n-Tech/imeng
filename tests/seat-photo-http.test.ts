import { describe, it, expect, afterAll } from "@jest/globals";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/mp-seat-photo-url");
const P = await import("../src/utils/seat-photo.js");

let answer: unknown = { people: [] }, status = 200;
const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer)); }); });
await new Promise<void>((r) => server.listen(39871, "127.0.0.1", r));
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const png = (): Promise<Buffer> => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
const nose = (c: number): number[][] => Array.from({ length: 17 }, (_, i) => [1, 2, i === 0 ? c : 0]);

describe("the local HTTP checker", () => {
  it("one person with a nose passes; two people, nobody, and a nose that is not visible do not", async () => {
    answer = { people: [{ score: 0.9, keypoints: nose(0.9) }] };
    expect(await P.checkSeatPhoto(await png())).toEqual({ ok: true, kind: "face" });
    answer = { people: [{ score: 0.9, keypoints: nose(0.9) }, { score: 0.8, keypoints: nose(0.9) }] };
    expect(await P.checkSeatPhoto(await png())).toEqual({ ok: false, reason: "many" });
    answer = { people: [] };
    expect(await P.checkSeatPhoto(await png())).toEqual({ ok: false, reason: "none" });
    answer = { people: [{ score: 0.9, keypoints: nose(0.1) }] };
    expect(await P.checkSeatPhoto(await png())).toEqual({ ok: false, reason: "unclear" });
    answer = { nonsense: true };
    expect(await P.checkSeatPhoto(await png())).toEqual({ ok: false, reason: "none" }); // a malformed answer finds nobody
  });
  it("a service that errors, or a file that is not a picture, fails closed", async () => {
    status = 500;
    expect(await P.checkSeatPhoto(await png())).toEqual({ ok: false, reason: "down" });
    status = 200;
    expect(await P.checkSeatPhoto(Buffer.from("not a picture"))).toEqual({ ok: false, reason: "format" });
  });
  it("imagesOf finds data: pictures in a message and ignores the rest", () => {
    const parse = (u: string): { mime: string; bytes: Buffer } | null => (u.startsWith("data:") ? { mime: "image/png", bytes: Buffer.from("x") } : null);
    expect(P.imagesOf([{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }, { type: "image_url", image_url: "data:image/png;base64,BB" }, { type: "image_url", image_url: { url: "https://x/y.png" } }], parse)).toHaveLength(2);
    expect(P.imagesOf("just text", parse)).toEqual([]);
  });
});
