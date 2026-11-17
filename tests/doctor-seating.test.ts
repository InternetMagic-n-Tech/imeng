import { describe, it, expect } from "@jest/globals";
import { runDoctor } from "../src/utils/doctor.js";
import { makeSettings, makeSys } from "./fake-sys.js";

const run = async (seating: unknown, over: { env?: Record<string, string>; files?: Record<string, string>; images?: unknown; vision?: unknown } = {}) => {
  const sys = makeSys({ files: over.files ?? {}, env: over.env ?? {} } as never);
  const r = await runDoctor(sys, makeSettings({ game: { seating, images: over.images, vision: over.vision } } as never));
  return r.findings.filter((x) => x.id.startsWith("seat-"));
};
const level = (fs: { id: string; level: string }[], id: string) => fs.find((x) => x.id === id)?.level;

describe("doctor: seat pictures", () => {
  it("says nothing without seating or without a photo rule", async () => {
    expect(await run(undefined)).toEqual([]);
    expect(await run({ approval: "none" })).toEqual([]);
  });
  it("fails a photo rule with no checker (no vision block and no check.url)", async () => {
    expect(level(await run({ photo: {} }), "seat-photo-check")).toBe("fail");
    expect(level(await run({ photo: { check: {} } }), "seat-photo-check")).toBe("fail");
  });
  it("accepts the vision module or a local service, warns when photos cannot be shown, and informs about nudity and a missing text file", async () => {
    const ok = await run({ photo: { text_file: "seat-photo.md", check: {} } }, { vision: { venv: "/v" } });
    expect(level(ok, "seat-photo-check")).toBe("ok");
    expect(level(ok, "seat-photo-serve")).toBe("warn"); // no images block: /images does not exist
    expect(level(ok, "seat-photo-text")).toBe("warn");
    expect(level(ok, "seat-photo-safety")).toBe("info");
    const url = await run({ photo: { show: false, check: { url: "http://127.0.0.1:9000" } } });
    expect(level(url, "seat-photo-check")).toBe("info");
    expect(url.find((x) => x.id === "seat-photo-serve")).toBeUndefined();
  });
});
