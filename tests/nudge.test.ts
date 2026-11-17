import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/nudge");
const { PRODUCER } = await import("../src/utils/config.js");
const { nudgeCommand, nudgeBlock } = await import("../src/utils/nudge.js");
const { parseCommand } = await import("../src/utils/commands.js");

const sess = (): any => ({ owner: { userId: "u-own" }, room: { players: { "u-prod": { actor: "p_prod" }, "u-bea": { actor: "user" } } }, snapshots: [{ game: {}, actors: { p_prod: { role: "producer" }, user: { role: "contestant" } } }] });
const prod = { userId: "u-prod", name: "Pat" }, bea = { userId: "u-bea", name: "Bea" };

describe("the producer's nudge", () => {
  it("is on by setting, and /nudge is a command", () => {
    expect(PRODUCER.nudge).toBe(true);
    expect(parseCommand("/nudge tone it down")).toMatchObject({ name: "nudge", arg: "tone it down" });
  });
  it("only the producer, and only in a private chat; empty text is refused", () => {
    const s = sess();
    expect(nudgeCommand("hi", { session: s, who: bea, shared: false })).toMatch(/Only the producer/);
    expect(nudgeCommand("hi", { session: s, who: { userId: "u-own", name: "Owner" }, shared: false })).toMatch(/Only the producer/); // owning the chat is not enough
    expect(nudgeCommand("hi", { session: s, who: prod, shared: true })).toMatch(/private/);
    expect(nudgeCommand("  ", { session: s, who: prod, shared: false })).toMatch(/Use \/nudge/);
    expect(s.nudges).toBeUndefined();
  });
  it("a nudge reaches the narrator once, labelled, then is forgotten; at most three wait", () => {
    const s = sess();
    expect(nudgeCommand("Bea is shy: go gentle", { session: s, who: prod, shared: false })).toMatch(/not told/);
    for (let i = 0; i < 2; i++) nudgeCommand(`n${i}`, { session: s, who: prod, shared: false });
    expect(nudgeCommand("one more", { session: s, who: prod, shared: false })).toMatch(/not used/);
    const b = nudgeBlock(s);
    expect(b).toContain("PRODUCER'S NUDGE");
    expect(b).toContain("Bea is shy: go gentle");
    expect(b).toContain("never announce");
    expect(nudgeBlock(s)).toBe("");
  });
});
