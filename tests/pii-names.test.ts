import { describe, it, expect } from "@jest/globals";
import { scrubNameText, scrubNameMessages, classify, Restorer, type Mention, type Chooser } from "../src/utils/pii-names.js";

const det = (ms: Mention[]) => async () => ms;
const pick = (c: "person" | "sensitive" | "animal" | null): Chooser => async () => c;
const never: Chooser = async () => { throw new Error("should not be asked"); };

describe("pii name layer", () => {
  it("keeps the relation beside the name hash, and restores the real words", async () => {
    const m: Mention = { text: "Uncle Joe", name: "Joe", kind: "relation", relation: "uncle" };
    const r = await scrubNameText("Uncle Joe is my priest, said Joe", { detect: det([m]), choose: pick("person") });
    expect(r.text).toMatch(/^\[uncle:[0-9a-f]{6}\] is my priest, said \[uncle:[0-9a-f]{6}\]$/);
    const rs = new Restorer(r.table);
    expect(rs.push(`Hello ${[...r.table.keys()][0]}!`) + rs.end()).toBe("Hello Uncle Joe!");
  });
  it("lets the judge pick between mappings, and takes the most protective when it fails or answers badly", async () => {
    const m: Mention = { text: "my priest Joe, who is a devout Catholic", name: "Joe", kind: "role", relation: "priest" };
    expect(await classify(m, "ctx", pick("sensitive"))).toBe("sensitive");
    expect(await classify(m, "ctx", pick("person"))).toBe("person");
    expect(await classify(m, "ctx", async () => { throw new Error("down"); })).toBe("sensitive");
    expect(await classify(m, "ctx", pick("animal"))).toBe("sensitive");
  });
  it("uses the game's own mapping: one option needs no judge, 'keep' leaves it clear", async () => {
    const own = [{ from: ["role"], to: ["person" as const] }, { from: ["relation"], to: ["keep" as const] }];
    expect(await classify({ text: "Dr Lee", kind: "role" }, "", never, own)).toBe("person");
    expect(await classify({ text: "my aunt", kind: "relation" }, "", never, own)).toBe("keep");
    expect(await classify({ text: "x", kind: "unheard-of" }, "", never)).toBe("keep");
  });
  it("masks a whole sensitive phrase and a named animal", async () => {
    const r = await scrubNameText("Bessie the cow got my sister Bea's gluten allergy", { detect: det([{ text: "Bessie the cow", name: "Bessie", kind: "animal" }, { text: "Bea's gluten allergy", kind: "health" }]), choose: never });
    expect(r.text).toMatch(/^\[animal:[0-9a-f]{6}\] got my sister \[sensitive:[0-9a-f]{6}\]$/);
  });
  it("gives twins different tokens that share the multiple qualifier", async () => {
    const r = await scrubNameText("My twin brothers Al and Bo came", { detect: det([{ text: "Al", kind: "person", relation: "brother", multiple: true }, { text: "Bo", kind: "person", relation: "brother", multiple: true }]), choose: never });
    const toks = r.text.match(/\[brother\+multiple:[0-9a-f]{6}\]/g)!;
    expect(toks).toHaveLength(2);
    expect(toks[0]).not.toBe(toks[1]);
  });
  it("leaves a class the game switched off in the clear", async () => {
    const r = await scrubNameText("Rex the dog and Zed the pilot", { detect: det([{ text: "Rex", kind: "animal" }, { text: "Zed", kind: "person" }]), choose: never, classes: ["person"] });
    expect(r.text).toMatch(/^Rex the dog and \[person:[0-9a-f]{6}\] the pilot$/);
  });
  it("refuses (throws) when the detector fails, and skips the model for tiny lowercase text", async () => {
    await expect(scrubNameText("Hello there Mr Quill, how are you", { detect: async () => { throw new Error("down"); }, choose: never })).rejects.toThrow("down");
    expect((await scrubNameText("go north", { detect: async () => { throw new Error("must not run"); }, choose: never })).text).toBe("go north");
  });
  it("only touches the player's messages", async () => {
    const r = await scrubNameMessages([{ role: "system", content: "Narrator Maya" }, { role: "user", content: "I am Maya Quillfeather" }, { role: "assistant", content: "Hi Maya Quillfeather" }], { detect: det([{ text: "Maya Quillfeather", kind: "person" }]), choose: never });
    expect(r.messages[0]!.content).toBe("Narrator Maya");
    expect(String(r.messages[1]!.content)).toMatch(/^I am \[person:/);
    expect(r.messages[2]!.content).toBe("Hi Maya Quillfeather");
  });
  it("restores a token split across stream chunks, and holds nothing back otherwise", () => {
    const rs = new Restorer(new Map([["[uncle:abc123]", "Uncle Joe"]]));
    const out = ["Hi [unc", "le:abc1", "23] and [oth", "er] ok"].map((c) => rs.push(c)).join("") + rs.end();
    expect(out).toBe("Hi Uncle Joe and [other] ok");
  });
});

import { scrubForLog } from "../src/utils/pii-filter.js";
describe("placeholders", () => {
  it("a secret becomes a fixed placeholder, never a hash", () => {
    const r = { text: scrubForLog("my password=hunter2hunter2 ok") };
    expect(r.text).toBe("my [SECRET] ok");
  });
});

describe("new-class judge", () => {
  it("masks private data the classes do not name as [other:...] and never restores it into the reply table wrongly", async () => {
    const extra = async () => [{ text: "7 Elm Street", kind: "other" } as Mention];
    const r = await scrubNameText("I live at 7 Elm Street, call me Bea", { detect: det([]), choose: never, extra });
    expect(r.text).toMatch(/^I live at \[other:[0-9a-f]{6}\], call me Bea$/);
    expect(r.found).toBe(1);
  });
  it("a failing extra judge throws, so the message is refused rather than let through", async () => {
    await expect(scrubNameText("I work at Acme Ltd, call me Bea", { detect: det([]), choose: never, extra: async () => { throw new Error("down"); } })).rejects.toThrow("down");
  });
});
