import { describe, it, expect } from "@jest/globals";
import { formatReport } from "../src/utils/doctor-format.js";
import type { Report } from "../src/utils/doctor.js";
import { GiB } from "../src/utils/doctor.js";

const report = (over: Partial<Report> = {}): Report => ({
  hardware: { platform: "linux", arch: "x64", cpuModel: "cpu", cores: 8, ramTotal: 32 * GiB, ramFree: 20 * GiB, unified: false, gpus: [{ name: "RTX 4090", vramTotal: 24 * GiB, vramUsed: 0, kind: "nvidia" }] },
  findings: [
    { id: "a", level: "ok", title: "all good" },
    { id: "b", level: "info", title: "just so you know", detail: "some detail" },
    { id: "c", level: "warn", title: "careful", detail: "why", fix: "do this" },
    { id: "d", level: "fail", title: "broken" },
  ],
  bailed: false,
  ...over,
});

describe("formatReport", () => {
  it("prints a header, every finding with detail and fix, and a summary", () => {
    const text = formatReport(report(), { gameDir: "/games/dungeon" }).join("\n");
    expect(text).toContain("Game proxy doctor: dungeon on linux/x64, 32 GiB RAM, RTX 4090");
    for (const t of ["✓ all good", "i just so you know", "    some detail", "⚠ careful", "    why", "    → do this", "✗ broken"]) expect(text).toContain(t);
    expect(text).toContain("1 ok, 1 info, 1 warning(s), 1 failure(s)");
    expect(text).not.toContain("\x1b[");
  });

  it("only lists warnings and failures when asked", () => {
    const text = formatReport(report(), { onlyProblems: true }).join("\n");
    expect(text).not.toContain("all good");
    expect(text).not.toContain("just so you know");
    expect(text).toContain("careful");
    expect(text).toContain("broken");
    expect(text).toContain("1 ok, 1 info, 1 warning(s), 1 failure(s)"); // summary still counts everything
  });

  it("adds colour codes only when asked", () => {
    expect(formatReport(report(), { color: true }).join("\n")).toContain("\x1b[32m✓\x1b[0m");
  });

  it("shows the suggested start command and the --bail note", () => {
    const text = formatReport(report({ suggestion: { contextLength: 20480, command: "OLLAMA_CONTEXT_LENGTH=20480 ollama serve" }, bailed: true })).join("\n");
    expect(text).toContain("Suggested Ollama start (context 20480):");
    expect(text).toContain("OLLAMA_CONTEXT_LENGTH=20480 ollama serve");
    expect(text).toContain("(stopped early: --bail)");
  });

  it("copes with no GPU and no game directory", () => {
    const r = report();
    r.hardware.gpus = [];
    const header = formatReport(r)[0];
    expect(header).toContain("32 GiB RAM\n");
    expect(header).not.toContain("RTX");
    expect(header).not.toContain(": ");
  });
});
