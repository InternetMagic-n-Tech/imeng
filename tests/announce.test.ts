import { describe, it, expect } from "@jest/globals";
import { announce, onAnnounce, takeFor } from "../src/utils/announce.js";

describe("announce", () => {
  it("default delivery: a table line for the next reply, or held for one person", async () => {
    const s: any = { snapshots: [] };
    await announce(s, { kind: "peek", text: "Someone peeked." });
    expect(s.own.notices).toEqual(["Someone peeked."]);
    await announce(s, { kind: "peek", to: "u1", text: "Bo peeked at your cards." });
    expect(takeFor(s, "u2")).toEqual([]);
    expect(takeFor(s, "u1")).toEqual(["Bo peeked at your cards."]);
    expect(takeFor(s, "u1")).toEqual([]);
  });
  it("an adapter hook that delivers it skips the default", async () => {
    const s: any = { snapshots: [] }, got: string[] = [];
    const off = onAnnounce((e) => { got.push(e.text); return true; });
    const e = await announce(s, { kind: "owner", text: "New owner." });
    off();
    expect(got).toEqual(["New owner."]); expect(e.delivered).toBe(true); expect(s.own).toBeUndefined();
  });
});
