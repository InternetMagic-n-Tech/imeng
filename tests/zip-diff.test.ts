import { describe, it, expect, beforeEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { zipSinceLast, listFiles } from "../src/utils/zip-diff.js";

let dir: string, src: string;
const w = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), s); };
const names = (zip: string): string[] => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "zd-")); src = path.join(dir, "proj"); fs.mkdirSync(src); });

describe("zipSinceLast", () => {
  it("packs everything the first time, then only what changed, and lists removed files", async () => {
    w("a.txt", "1"); w("sub/b.txt", "1"); w("node_modules/x/y.js", "no"); w("logs/t.log", "no"); w("old.zip", "no"); w(".env", "secret");
    expect(listFiles(src)).toEqual(["a.txt", "sub/b.txt"]);
    const first = await zipSinceLast({ src });
    expect(path.basename(first.out)).toBe("proj-changes-1.zip");
    expect(names(first.out)).toEqual(["a.txt", "sub/b.txt"]);
    expect((await zipSinceLast({ src })).files).toEqual([]);
    w("a.txt", "2"); w("c.txt", "new"); fs.rmSync(path.join(src, "sub/b.txt"));
    const second = await zipSinceLast({ src });
    expect(path.basename(second.out)).toBe("proj-changes-2.zip");
    expect(names(second.out)).toEqual(["ZIP-DELETED.txt", "a.txt", "c.txt"]);
    expect(execFileSync("unzip", ["-p", second.out, "ZIP-DELETED.txt"], { encoding: "utf8" })).toBe("sub/b.txt\n");
    expect(fs.existsSync(path.join(src, "ZIP-DELETED.txt"))).toBe(false);
  });
  it("--all packs everything; --out names the file; --since stands in for missing state", async () => {
    w("a.txt", "1"); w("b.txt", "1");
    const past = new Date(Date.now() - 100000), recent = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(src, "a.txt"), past, past); fs.utimesSync(path.join(src, "b.txt"), recent, recent);
    const since = await zipSinceLast({ src, since: new Date().toISOString(), out: path.join(dir, "s.zip") });
    expect(names(since.out)).toEqual(["b.txt"]);
    const all = await zipSinceLast({ src, all: true, out: path.join(dir, "all.zip") });
    expect(names(all.out)).toEqual(["a.txt", "b.txt"]);
    const ref = path.join(dir, "last.zip"); fs.writeFileSync(ref, "x");
    fs.rmSync(path.join(src, ".zip-state.json"));
    expect((await zipSinceLast({ src, since: ref, out: path.join(dir, "r.zip") })).files).toEqual(["b.txt"]);
    fs.rmSync(path.join(src, ".zip-state.json"));
    await expect(zipSinceLast({ src, since: "not a date" })).rejects.toThrow(/--since/);
  });
  it("uses a given zipper and does not record state if it fails", async () => {
    w("a.txt", "1");
    await expect(zipSinceLast({ src, run: async () => { throw new Error("no zip"); } })).rejects.toThrow("no zip");
    expect(fs.existsSync(path.join(src, ".zip-state.json"))).toBe(false);
    let got: string[] = [];
    const r = await zipSinceLast({ src, run: async (_o, files) => { got = files; } });
    expect(got).toEqual(["a.txt"]); expect(r.files).toEqual(["a.txt"]);
  });
});
