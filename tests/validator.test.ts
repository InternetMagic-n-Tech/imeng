import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/validate");
const ollama = makeOllama();
let app: typeof import("../src/app.js").app;
let sessions: typeof import("../src/utils/sessions.js").sessions;
beforeAll(async () => { ({ app } = await import("../src/app.js")); ({ sessions } = await import("../src/utils/sessions.js")); });
beforeEach(() => { ollama.reset(); for (const m of ["log", "warn"] as const) jest.spyOn(console, m).mockImplementation(() => {}); });

const turn = async (id: string, ops: unknown[]) => {
  ollama.s.narration = "Point to Bea."; ollama.s.extractor.push(ops);
  await request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id).send({ messages: [{ role: "user", content: "hello" }] });
  await sessions.get("chat:" + id)!.tail;
  return sessions.get("chat:" + id)!.snapshots.at(-1)!;
};

describe("per-imeng validator and the repair judge", () => {
  it("refuses an op the imeng's function rejects, then applies the judge's one corrected op", async () => {
    ollama.s.repairs.push({ ops: [{ op: "set", path: "actors.user.score", value: 3 }] });
    const st = await turn("v1", [{ op: "set", path: "actors.user.score", value: 9 }]);
    expect(st.actors.user.score).toBe(3);
    expect(ollama.calls("repair")).toHaveLength(1);
  });
  it("drops the op when the corrected one is refused too (one retry only)", async () => {
    ollama.s.repairs.push({ ops: [{ op: "set", path: "actors.user.score", value: 8 }] });
    const st = await turn("v2", [{ op: "set", path: "actors.user.score", value: 9 }]);
    expect(st.actors.user.score).toBe(0);
    expect(ollama.calls("repair")).toHaveLength(1);
  });
  it("lets a valid op straight through without asking the judge", async () => {
    const st = await turn("v3", [{ op: "set", path: "actors.user.score", value: 2 }]);
    expect(st.actors.user.score).toBe(2);
    expect(ollama.calls("repair")).toHaveLength(0);
  });
});
