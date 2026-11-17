import { describe, it, expect } from "@jest/globals";
import { sniff, usable, mimeOf, extOf } from "../src/utils/image-format.js";
import { PNG } from "./fake-renderer.js";

const b = (...v: number[]) => Uint8Array.from(v);
describe("image format look-ahead", () => {
  it("recognises the formats by their first bytes", () => {
    expect(sniff(PNG)).toBe("png");
    expect(sniff(b(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]))).toBe("webp");
    expect(sniff(Buffer.from("GIF89a"))).toBe("gif");
    expect(sniff(Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(sniff(Buffer.from("  <svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("svg");
    expect(sniff(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe("svg");
    expect(sniff(Buffer.from("hello"))).toBe("unknown");
  });
  it("only png, jpeg and webp are usable", () => {
    expect(["png", "jpeg", "webp", "gif", "svg", "pdf", "unknown"].map((k) => usable(k as never))).toEqual([true, true, true, false, false, false, false]);
    expect(mimeOf("jpeg")).toBe("image/jpeg");
    expect(mimeOf("png")).toBe("image/png");
    expect(extOf("jpeg")).toBe("jpg");
    expect(extOf("webp")).toBe("webp");
  });
});
