import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { extractImages, convertWithSharp } from "../src/utils/md-assets.js";
import { buildGame } from "../src/utils/md-build.js";
import { systemPromptPath } from "../src/utils/early-flags.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdb-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const png = async (): Promise<Buffer> => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png({ compressionLevel: 0 }).toBuffer();
const uri = (b: Buffer, mime = "png"): string => `data:image/${mime};base64,${b.toString("base64")}`;

describe("extractImages", () => {
  it("moves inline images to assets, named from their content, as webp when smaller", async () => {
    const b = await png();
    const text = `![logo](${uri(b)})\n\nagain ![logo](${uri(b)})\n\n<img alt="pic" src="${uri(b)}" width="5">\n\n[ref]: ${uri(b)}\n`;
    const r = await extractImages(text, dir);
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]).toMatch(/^[0-9a-f]{12}\.webp$/);
    expect(r.text).toBe(`![logo](assets/${r.saved[0]})\n\nagain ![logo](assets/${r.saved[0]})\n\n![pic](assets/${r.saved[0]})\n\n[ref]: assets/${r.saved[0]}\n`);
    expect(fs.readdirSync(path.join(dir, "assets"))).toEqual(r.saved);
    expect(r.after).toBeLessThan(r.before);
  });
  it("keeps svg and falls back to the original when it cannot convert", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const r1 = await extractImages(`![s](${uri(svg, "svg+xml")})`, dir);
    expect(r1.saved[0]).toMatch(/\.svg$/);
    const r2 = await extractImages(`![j](${uri(Buffer.from("not an image"), "jpeg")})`, dir);
    expect(r2.saved[0]).toMatch(/\.jpg$/);
    expect((await convertWithSharp(Buffer.from("x"), "png")).ext).toBe("png");
  });
  it("does not rewrite an existing asset and leaves normal images alone", async () => {
    const stub = jest.fn(async (b: Buffer) => ({ bytes: b, ext: "png" }));
    const text = `![a](${uri(Buffer.from("abc"))}) ![n](pics/n.png)`;
    await extractImages(text, dir, stub);
    const file = path.join(dir, "assets", fs.readdirSync(path.join(dir, "assets"))[0]);
    fs.writeFileSync(file, "kept");
    const r = await extractImages(text, dir, stub);
    expect(fs.readFileSync(file, "utf8")).toBe("kept");
    expect(r.text).toContain("![n](pics/n.png)");
  });
});

describe("buildGame", () => {
  const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  it("renders templates, skips up-to-date outputs, rebuilds when a part changes or with force", async () => {
    write("SYSTEM_PROMPT.template.md", "Hi\n\n[r](parts/r.md)\n"); write("parts/r.md", "Rules\n");
    const logs: string[] = [];
    const a = await buildGame(dir, { log: (l) => logs.push(l) });
    expect(a.built).toEqual([path.join(dir, "SYSTEM_PROMPT.md")]);
    expect(fs.readFileSync(path.join(dir, "SYSTEM_PROMPT.md"), "utf8")).toBe("Hi\n\nRules\n");
    expect(logs[0]).toMatch(/built SYSTEM_PROMPT\.md from 2 file\(s\) in \d+ms/);
    expect((await buildGame(dir)).skipped).toHaveLength(1);
    const future = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, "parts/r.md"), future, future);
    expect((await buildGame(dir)).built).toHaveLength(1);
    expect((await buildGame(dir, { force: true })).built).toHaveLength(1);
  });
  it("moves inline images out of every markdown file and leaves other games' files alone", async () => {
    write("VISION.md", `# v\n![x](${uri(await png())})\n`); write("node_modules/p/README.md", `![x](${uri(await png())})`);
    const r = await buildGame(dir, { log: () => {} });
    expect(r.images).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "VISION.md"), "utf8")).toMatch(/!\[x\]\(assets\/[0-9a-f]{12}\.webp\)/);
    expect(fs.readFileSync(path.join(dir, "node_modules/p/README.md"), "utf8")).toContain("base64");
    expect((await buildGame(dir)).images).toHaveLength(0);
  });
  it("a game with nothing to build is untouched, a missing folder is an error", async () => {
    write("SYSTEM_PROMPT.md", "plain");
    expect(await buildGame(dir)).toEqual({ built: [], skipped: [], images: [] });
    await expect(buildGame(path.join(dir, "nope"))).rejects.toThrow(/not found/);
  });
});

describe("systemPromptPath", () => {
  it("the flag wins over the env var; empty by default", () => {
    expect(systemPromptPath([], {})).toBe("");
    expect(systemPromptPath([], { SYSTEM_PROMPT_PATH: "e.md" })).toBe("e.md");
    expect(systemPromptPath(["--system-prompt", "f.md", "--other", "1"], { SYSTEM_PROMPT_PATH: "e.md" })).toBe("f.md");
  });
});

import { experimentPerChat, telemetryEnabled } from "../src/utils/early-flags.js";
describe("experimentPerChat", () => {
  it("is off by default, the env var turns it on and the flag wins either way", () => {
    expect(experimentPerChat([], {})).toBe(false);
    expect(experimentPerChat([], { MLFLOW_EXPERIMENT_PER_CHAT: "1" })).toBe(true);
    expect(experimentPerChat(["--no-experiment-per-chat"], { MLFLOW_EXPERIMENT_PER_CHAT: "1" })).toBe(false);
    expect(experimentPerChat(["--experiment-per-chat"], {})).toBe(true);
  });
});

describe("telemetryEnabled", () => {
  it("is on by default, off with TELEMETRY=off, and the flag wins", () => {
    expect(telemetryEnabled([], {})).toBe(true);
    expect(telemetryEnabled([], { TELEMETRY: "off" })).toBe(false);
    expect(telemetryEnabled([], { TELEMETRY: "0" })).toBe(false);
    expect(telemetryEnabled(["--no-telemetry"], {})).toBe(false);
    expect(telemetryEnabled(["--telemetry"], { TELEMETRY: "off" })).toBe(true);
  });
});
