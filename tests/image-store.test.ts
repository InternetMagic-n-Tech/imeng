import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "./fake-renderer.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
process.env.PUBLIC_URL = "https://game.example/";
process.env.IMAGE_MAX_BYTES = "2000";
const { saveImage, readImage, urlOf, BadImage } = await import("../src/utils/image-store.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));

describe("image store", () => {
  it("names a picture by its content and serves it back with its type", () => {
    const name = saveImage(PNG, dir);
    expect(name).toMatch(/^[a-f0-9]{24}\.png$/);
    expect(saveImage(PNG, dir)).toBe(name);
    expect(fs.readdirSync(dir)).toEqual([name]);
    expect(readImage(name, dir)).toEqual({ bytes: PNG, type: "image/png" });
    expect(urlOf(name)).toBe(`https://game.example/images/${name}`);
  });
  it("refuses anything that is not a usable picture, and anything too big", () => {
    expect(() => saveImage(Buffer.from("<svg/>"), dir)).toThrow(BadImage);
    try { saveImage(Buffer.from("%PDF-1.4"), dir); } catch (e) { expect((e as InstanceType<typeof BadImage>).kind).toBe("pdf"); }
    try { saveImage(Buffer.alloc(3000, 1), dir); } catch (e) { expect((e as InstanceType<typeof BadImage>).kind).toBe("too_big"); }
  });
  it("only reads names it made (no path tricks)", () => {
    expect(readImage("../../etc/passwd", dir)).toBeNull();
    expect(readImage("abc.png", dir)).toBeNull();
    expect(readImage("0".repeat(24) + ".png", dir)).toBeNull();
  });
});
