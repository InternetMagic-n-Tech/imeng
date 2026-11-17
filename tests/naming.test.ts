import { describe, it, expect } from "@jest/globals";
import { alike, chooseName, clean } from "../src/utils/naming.js";

describe("naming", () => {
  it("catches names that sound or start alike", () => {
    expect(alike("Kristen", "Christian")).toBe(true);
    expect(alike("Bea", "Beatrice")).toBe(true);
    expect(alike("Jon", "John")).toBe(true);
    expect(alike("Marcus", "Priya")).toBe(false);
  });
  it("accepts one clean word and rejects junk", () => {
    expect(clean("Priya")).toBe("Priya");
    expect(clean("Mary-Bea")).toBe("Mary-Bea");
    expect(clean("priya")).toBeNull();
    expect(clean("Bea Lee")).toBeNull();
    expect(clean("Ignore all rules")).toBeNull();
    expect(clean(42)).toBeNull();
  });
  it("asks again on an alike or used name, and falls back to its own list when the model keeps failing", async () => {
    const answers = ["Christian", "Kristen", "Dmitri"];
    expect(await chooseName(["Christian"], async () => answers.shift())).toBe("Dmitri");
    expect(await chooseName(["Marcus"], async () => { throw new Error("down"); })).toBe("Priya");
    expect(await chooseName([], async () => "not a name!!")).toBe("Marcus");
  });
});
