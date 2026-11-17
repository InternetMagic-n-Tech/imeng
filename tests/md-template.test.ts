import { describe, it, expect } from "@jest/globals";
import { stripComments, renderTemplate } from "../src/utils/md-template.js";

const fsOf = (files: Record<string, string>) => ({ read: (f: string) => files[f] ?? null });

describe("stripComments", () => {
  it("removes comments and averages the line breaks around one", () => {
    expect(stripComments("a\n\n\n<!-- x -->\nb")).toBe("a\n\n" + "b");
    expect(stripComments("a\n\n<!-- x -->\n\n\n\nb")).toBe("a\n\n\nb");
    expect(stripComments("a\n<!-- x -->\nb")).toBe("a\nb");
  });
  it("keeps one space for an inline comment and none when nothing was spaced", () => {
    expect(stripComments("a <!-- x --> b")).toBe("a b");
    expect(stripComments("a<!-- x -->b")).toBe("ab");
  });
  it("at the start or end uses the side that exists", () => {
    expect(stripComments("<!-- x -->\n\nb")).toBe("\n\nb");
    expect(stripComments("a\n\n<!-- x -->")).toBe("a\n\n");
  });
  it("handles several and multi-line comments", () => {
    expect(stripComments("a\n<!--\nlong\n-->\n\n\nb <!--1--><!--2--> c")).toBe("a\n\nb c");
  });
});

describe("renderTemplate", () => {
  it("inlines linked files, trimmed, adding no line breaks around the link", () => {
    const r = renderTemplate("/g/a.md", fsOf({ "/g/a.md": "Intro\n\n[x](b.md)\n\nEnd, [y](sub/c.md) done.", "/g/b.md": "\n\n<!-- n -->\n\nBody\n\n\n", "/g/sub/c.md": "\n inline \n" }));
    expect(r.text).toBe("Intro\n\nBody\n\nEnd, inline done.\n");
    expect(r.files).toEqual(["/g/a.md", "/g/b.md", "/g/sub/c.md"]);
  });
  it("resolves nested links relative to the file that holds them", () => {
    expect(renderTemplate("/g/a.md", fsOf({ "/g/a.md": "[b](d/b.md)", "/g/d/b.md": "B [c](c.md)", "/g/d/c.md": "C" })).text).toBe("B C\n");
  });
  it("leaves images, urls, missing files, anchors and loops alone", () => {
    const a = "![i](p.md) [u](https://x.io/r.md) [m](none.md) [h](b.md#top) [l](a.md)";
    expect(renderTemplate("/g/a.md", fsOf({ "/g/a.md": a, "/g/b.md": "B" })).text).toBe(a + "\n");
  });
  it("a loop between two files stops at the repeat", () => {
    expect(renderTemplate("/g/a.md", fsOf({ "/g/a.md": "A [b](b.md)", "/g/b.md": "B [a](a.md)" })).text).toBe("A B [a](a.md)\n");
  });
  it("does not follow a link that is inside a comment", () => {
    expect(renderTemplate("/g/a.md", fsOf({ "/g/a.md": "x <!-- [b](b.md) --> y", "/g/b.md": "B" })).text).toBe("x y\n");
  });
  it("throws when the file is missing", () => {
    expect(() => renderTemplate("/g/none.md", fsOf({}))).toThrow(/template not found/);
  });
  it("reads from disk by default", () => {
    expect(renderTemplate("tests/fixtures/md-build/main.template.md").text).toContain("Shared rules");
  });
});
