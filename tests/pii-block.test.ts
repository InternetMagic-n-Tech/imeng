import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { makeOllama } from "./fake-ollama.js";
import { makeChat } from "./table-helper.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/pii-block");
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");

const ollama = makeOllama();
beforeEach(() => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe("pii_filter on_detect block", () => {
  it("refuses a message with personal details and calls no model", async () => {
    const t = makeChat(app, "b1");
    expect(await t.send({ id: "u-bea", name: "Bea" }, "Let's play, mail me at bea@example.com")).toBe("That message looks like it has personal details in it (like an email, phone or card number), so I haven't read it. Please leave them out and send it again.");
    expect(ollama.calls("narrator")).toHaveLength(0);
    expect(ollama.calls("invocation")).toHaveLength(0);
  });
  it("lets a clean message through", async () => {
    const t = makeChat(app, "b2");
    expect(await t.send({ id: "u-bea", name: "Bea" }, "Let's play")).toBe("The torch flickers.");
  });
});
