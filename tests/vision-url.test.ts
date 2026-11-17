import { describe, it, expect, afterEach } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/vision-url");
const V = await import("../src/utils/vision.js");

afterEach(() => V.setVisionIO(null));
const answer = (body: unknown, status = 200): typeof fetch => (async (_u: unknown, init: any) => { (answer as any).last = JSON.parse(init.body); return new Response(JSON.stringify(body), { status }); }) as never;

describe("the vision module over HTTP (a worker someone else runs)", () => {
  it("posts the same JSON as the worker's lines and reads the same answers", async () => {
    V.setVisionIO({ fetch: answer({ id: 1, ok: true, people: [{ score: 0.7, keypoints: [[1, 2, 0.9]] }] }) });
    const people = await V.visionPose(Buffer.from("x"));
    expect(people[0].keypoints[0]).toEqual({ x: 1, y: 2, c: 0.9 });
    expect((answer as any).last).toMatchObject({ op: "pose", image: Buffer.from("x").toString("base64") });
    V.setVisionIO({ fetch: answer({ id: 1, ok: true, hits: [{ label: "ANUS_EXPOSED", score: 0.99 }] }) });
    expect(await V.visionCensor(Buffer.from("y"))).toEqual([{ label: "ANUS_EXPOSED", score: 0.99 }]);
  });
  it("an HTTP error, a failure answer and a malformed answer are failures or nobody", async () => {
    V.setVisionIO({ fetch: answer({}, 502) });
    await expect(V.visionPose(Buffer.from("x"))).rejects.toThrow(/502/);
    V.setVisionIO({ fetch: answer({ ok: false, error: "no model" }) });
    await expect(V.visionCensor(Buffer.from("x"))).rejects.toThrow("no model");
    V.setVisionIO({ fetch: answer({ ok: true, nonsense: 1 }) });
    expect(await V.visionPose(Buffer.from("x"))).toEqual([]);
  });
});
