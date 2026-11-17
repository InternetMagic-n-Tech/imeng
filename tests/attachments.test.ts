import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import { Readable } from "node:stream";
import { makeOllama } from "./fake-ollama.js";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/attach");
process.env.ATTACH_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "attach-cache-"));
const { app } = await import("../src/app.js");
const { sessions } = await import("../src/utils/sessions.js");
const { flushLogs } = await import("../src/utils/logger.js");
const { dbMain } = await import("../src/utils/db-cli.js");
const { startState, stopState, stateDb } = await import("../src/utils/db-state.js");
const B = await import("../src/utils/bucket.js");
const { parseDataUri, captureBytes } = await import("../src/utils/attachments.js");

const ollama = makeOllama();
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const URI = `data:image/png;base64,${PNG.toString("base64")}`;

const fakeBucket = () => {
  const store = new Map<string, Buffer>();
  return { store, bucketExists: async () => true, makeBucket: async () => {}, putObject: async (_b: string, k: string, d: Buffer) => { store.set(k, d); }, getObject: async (_b: string, k: string) => Readable.from([store.get(k)!]) };
};
const send = (chat: string, content: unknown) => request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", chat).set("x-openwebui-user-id", "u-bea").send({ messages: [{ role: "user", content }] });

beforeEach(async () => {
  ollama.reset(); ollama.s.narration = "The torch flickers."; ollama.s.invoke = { invoked: true, reason: "asks to play" };
  sessions.clear();
  fs.rmSync(process.env.SAVE_DIR!, { recursive: true, force: true }); fs.mkdirSync(process.env.SAVE_DIR!, { recursive: true });
  fs.rmSync(process.env.ATTACH_CACHE_DIR!, { recursive: true, force: true });
  for (const m of ["log", "warn", "error"] as const) jest.spyOn(console, m).mockImplementation(() => {}).mockClear();
  const file = `sqlite:${process.env.SAVE_DIR}/a.sqlite`;
  await dbMain([], file, () => {});
  await startState(file, { exit: () => {} });
});
afterEach(async () => { await stopState(); B._useClient(null); jest.restoreAllMocks(); });

describe("attachments", () => {
  it("reads a data: URI", () => {
    expect(parseDataUri(URI)).toEqual({ mime: "image/png", bytes: PNG });
    expect(parseDataUri("https://x.test/a.png")).toBeNull();
  });

  it("keeps an attached picture: bucket, database row, and the models see only a placeholder", async () => {
    const bucket = fakeBucket();
    B._useClient(bucket);
    const res = await send("att1", [{ type: "text", text: "Imeng: Test Adventure, look at this" }, { type: "image_url", image_url: { url: URI } }]);
    expect(res.status).toBe(200);
    await sessions.get("chat:att1")!.tail; await flushLogs();
    const rows = await stateDb()!.selectFrom("attachments").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session: "chat:att1", user_id: "u-bea", source: "openwebui", mime: "image/png", bytes: PNG.length, message_index: 0, turn: 1, cached: 0 });
    expect(rows[0].bucket_key).toBe(`uploads/chat_att1/${rows[0].id}`);
    expect(bucket.store.get(rows[0].bucket_key as string)).toEqual(PNG);
    const sent = JSON.stringify(ollama.calls("narrator").map((c) => c.body));
    expect(sent).toContain(`[image:${rows[0].id}]`);
    expect(sent).not.toContain(PNG.toString("base64"));
    expect(fs.readdirSync(process.env.ATTACH_CACHE_DIR!)).toEqual([]); // the bucket took it, so the staged copy is gone
  });

  it("stores the same picture once when the history is sent again", async () => {
    B._useClient(fakeBucket());
    const msg = [{ type: "text", text: "Imeng: Test Adventure" }, { type: "image_url", image_url: { url: URI } }];
    await send("att2", msg); await sessions.get("chat:att2")!.tail;
    await send("att2", msg); await sessions.get("chat:att2")!.tail; await flushLogs();
    expect(await stateDb()!.selectFrom("attachments").selectAll().execute()).toHaveLength(1);
  });

  it("keeps the staged file when the bucket is down, and still records it", async () => {
    B._useClient({ ...fakeBucket(), putObject: async () => { throw new Error("connection refused"); } });
    const s = await captureBytes(PNG, "image/png", { session: "chat:x", source: "openwebui" });
    expect(s).toMatchObject({ bucketKey: null, cached: true });
    expect(fs.readdirSync(process.env.ATTACH_CACHE_DIR!)).toHaveLength(1);
    expect((await stateDb()!.selectFrom("attachments").selectAll().execute())[0]).toMatchObject({ cached: 1, bucket_key: null });
  });

  it("refuses an empty or too big file", async () => {
    expect(await captureBytes(Buffer.alloc(0), "image/png", { session: "s", source: "other" })).toBeNull();
    process.env.ATTACH_MAX_BYTES = "4";
    expect(await captureBytes(PNG, "image/png", { session: "s", source: "other" })).toBeNull();
    delete process.env.ATTACH_MAX_BYTES;
  });

  it("leaves messages alone when ATTACH_CAPTURE is off", async () => {
    process.env.ATTACH_CAPTURE = "off";
    await send("att3", [{ type: "text", text: "Imeng: Test Adventure" }, { type: "image_url", image_url: { url: URI } }]);
    await sessions.get("chat:att3")?.tail;
    expect(await stateDb()!.selectFrom("attachments").selectAll().execute()).toHaveLength(0);
    delete process.env.ATTACH_CAPTURE;
  });
});
