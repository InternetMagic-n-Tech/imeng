import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/images");
const { parseCommand, foldCommands, isYes, attachedImage } = await import("../src/utils/commands.js");
const { OFFER_PREFIX } = await import("../src/utils/image-config.js");
const u = (content: unknown) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

describe("chat commands", () => {
  it("parses /draw and /portrait with their argument, in any case", () => {
    expect(parseCommand("/draw the corridor")).toEqual({ name: "draw", arg: "the corridor", attached: undefined });
    expect(parseCommand("/Portrait  Bo ")).toMatchObject({ name: "portrait", arg: "Bo" });
    expect(parseCommand("/draw")).toMatchObject({ arg: "" });
    expect(parseCommand("draw something")).toBeNull();
    expect(parseCommand("/drawn")).toBeNull();
    expect(parseCommand("/unknown x")).toBeNull();
  });
  it("finds a picture attached to the message", () => {
    const content = [{ type: "text", text: "/portrait Bo" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }];
    expect(attachedImage(content)).toBe("data:image/png;base64,AAAA");
    expect(parseCommand(content)).toMatchObject({ name: "portrait", arg: "Bo", attached: "data:image/png;base64,AAAA" });
    expect(attachedImage([{ type: "image_url", image_url: "data:x" }])).toBe("data:x");
    expect(attachedImage("text")).toBeUndefined();
    expect(attachedImage([{ type: "text" }])).toBeUndefined();
  });
  it("takes commands and their replies out of the conversation, so no round is counted", () => {
    const msgs = [u("hello"), a("Welcome."), u("/draw the door"), a("![door](http://x/1.png)"), u("I open it"), a("It creaks."), u("/portrait Bo")];
    const f = foldCommands(msgs);
    expect(f.messages.map((m) => m.content)).toEqual(["hello", "Welcome.", "I open it", "It creaks."]);
    expect(f.latest).toMatchObject({ name: "portrait", arg: "Bo" });
    expect(foldCommands(msgs.slice(0, 6)).latest).toBeNull();
  });
  it("treats a yes to an offer as the confirmation, and a request that got an offer as a note", () => {
    const offer = `${OFFER_PREFIX} "the door"? Reply yes to make it.`;
    const f = foldCommands([u("hi"), a("Hello."), u("show me a picture of the door"), a(offer), u("yes")]);
    expect(f.messages.map((m) => m.content)).toEqual(["hi", "Hello."]);
    expect(f.latest).toEqual({ name: "yes", arg: "" });
    expect(foldCommands([u("hi"), a("Hello."), u("yes")]).latest).toBeNull(); // no offer: just a message
    expect(foldCommands([u("hi"), a("Hello."), u("show me a picture of the door"), a(offer)]).latest).toBeNull();
    expect(isYes("Yes!")).toBe(true);
    expect(isYes("yes please")).toBe(false);
  });
});
