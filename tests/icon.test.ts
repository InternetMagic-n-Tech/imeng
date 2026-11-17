import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "@jest/globals";
import { ICON_MAX_BYTES, iconNameProblem, iconUrl, readIcon, sendIcon } from "../src/utils/icon.js";
import { runDoctor } from "../src/utils/doctor.js";
import { makeSettings, makeSys } from "./fake-sys.js";

const tmp: string[] = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "icon-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("iconNameProblem", () => {
  it("accepts an image file name in the folder and refuses the rest", () => {
    expect(iconNameProblem("The_Backrooms.jpg")).toBeNull();
    expect(iconNameProblem("A.PNG")).toBeNull();
    for (const bad of ["", "../x.png", "sub/x.png", ".hidden.png", "x.svg", "x", "x.png.exe"]) expect(iconNameProblem(bad)).not.toBeNull();
  });
});

describe("readIcon", () => {
  it("reads a valid file with its type", () => {
    const d = mk(); fs.writeFileSync(path.join(d, "a.jpg"), "JPEG");
    expect(readIcon(d, "a.jpg")).toEqual({ bytes: Buffer.from("JPEG"), type: "image/jpeg" });
  });
  it("returns null for no name, a bad name, a missing file, a directory, an oversize file", () => {
    const d = mk();
    expect(readIcon(d, undefined)).toBeNull();
    expect(readIcon(d, "../a.png")).toBeNull();
    expect(readIcon(d, "gone.png")).toBeNull();
    fs.mkdirSync(path.join(d, "dir.png"));
    expect(readIcon(d, "dir.png")).toBeNull();
    fs.writeFileSync(path.join(d, "big.png"), Buffer.alloc(ICON_MAX_BYTES + 1));
    expect(readIcon(d, "big.png")).toBeNull();
  });
  it("refuses a symlink that leaves the game folder", () => {
    const d = mk(), out = mk(); fs.writeFileSync(path.join(out, "secret.png"), "x");
    fs.symlinkSync(path.join(out, "secret.png"), path.join(d, "link.png"));
    expect(readIcon(d, "link.png")).toBeNull();
  });
});

describe("sendIcon and iconUrl", () => {
  it("sends the bytes with a cache header, or 404", async () => {
    const app = express();
    app.get("/ok", (_q, r) => sendIcon(r, { bytes: Buffer.from("PNG"), type: "image/png" }));
    app.get("/no", (_q, r) => sendIcon(r, null));
    const s = http.createServer(app); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/ok`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toMatch(/max-age/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/no`)).status).toBe(404);
    await new Promise((r) => { s.closeAllConnections(); s.close(r); });
  });
  it("builds the address from PUBLIC_URL and the model id", () => {
    expect(iconUrl("http://h:3001/", "a b")).toBe("http://h:3001/icons/a%20b");
  });
});

describe("doctor: icon", () => {
  const run = async (icon: string, files: Record<string, string> = {}) => (await runDoctor(makeSys({ files }), makeSettings({ game: { icon } as never }))).findings.find((x) => x.id === "game-config");
  it("reports a bad name or a missing file, and accepts a present one", async () => {
    expect((await run("../x.png"))?.detail).toMatch(/icon must be a file name/);
    expect((await run("x.svg"))?.detail).toMatch(/png, jpg, webp or gif/);
    expect((await run("pic.png"))?.detail).toMatch(/icon pic.png was not found/);
    expect((await run("pic.png", { "/game/pic.png": "x" }))?.level).toBe("ok");
  });
});
