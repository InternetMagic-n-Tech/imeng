import { describe, it, expect } from "@jest/globals";
import { buildCatalog, renderCatalog, launchWords, asksWhatThisIs } from "../src/utils/catalog.js";

describe("what is this? intro", () => {
  it("reads launch words and skips a misspelling", () => {
    expect(launchWords('If the user\'s first message is "Imeng: Backrooms" (or the misspelling "Imeng: Backroms") follow these instructions.')).toEqual(["Imeng: Backrooms"]);
  });
  it("lists every imeng once, flavours merged, with a description (a fixture folder, not the shipped games)", async () => {
    const c = await buildCatalog("tests/fixtures/catalog");
    expect(c.map((e) => e.launch)).toEqual([["Imeng: Quest"], ["Imeng: Quiz Show"]]);
    const quiz = c.find((e) => e.launch.includes("Imeng: Quiz Show"))!;
    expect(quiz.flavours.sort()).toEqual(["show/solo", "show/table"].map((f) => f.replace("show/", "")).sort());
    expect(c.every((e) => e.description.length > 10)).toBe(true);
    const t = renderCatalog(c);
    expect(t).toContain("Internet Magic Engine");
    expect(t).toContain("**Imeng: Quiz Show**");
    expect(t).toContain("(versions: solo, table)");
  });
  it("builds a catalog from the shipped imengs folder without throwing", async () => {
    const c = await buildCatalog("imengs");
    expect(c.length).toBeGreaterThan(0);
  });
  it("recognises help questions but not ordinary ones", () => {
    for (const m of ["What is this?", "what can I do", "hi, what is this", "help", "How do I start?"]) expect(asksWhatThisIs(m)).toBe(true);
    for (const m of ["what is the capital of France?", "write me a poem", "Imeng: Quiz Show"]) expect(asksWhatThisIs(m)).toBe(false);
  });
});
