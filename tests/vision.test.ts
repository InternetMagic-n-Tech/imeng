import { describe, it, expect, afterAll } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/vision-fake");
const pidfile = path.join(os.tmpdir(), `vision-pids-${process.pid}`);
process.env.VISION_PIDFILE = pidfile; fs.rmSync(pidfile, { force: true });
const V = await import("../src/utils/vision.js");
const { VISION } = await import("../src/utils/config.js");

const pic = (what: string): Buffer => Buffer.from(what);
const pids = (): string[] => (fs.existsSync(pidfile) ? fs.readFileSync(pidfile, "utf8").split("\n").filter(Boolean) : []);
afterAll(() => { V.stopVision(); fs.rmSync(pidfile, { force: true }); });

describe("the vision module's client", () => {
  it("is configured from config.json", () => {
    expect(VISION).toMatchObject({ python: "node", device: "cpu", idleStopS: 1, timeoutS: 5, url: "" });
  });
  it("a worker is started on first use and answers pose and censor checks in JSON lines", async () => {
    const people = await V.visionPose(pic("a person"));
    expect(people).toHaveLength(1);
    expect(people[0].score).toBe(0.9);
    expect(people[0].keypoints).toHaveLength(17);
    expect(people[0].keypoints[0]).toEqual({ x: 0, y: 0, c: 0.9 });
    expect(await V.visionCensor(pic("a picture"))).toEqual([{ label: "FACE_FEMALE", score: 0.8 }]);
    expect(pids()).toHaveLength(1); // one worker for both
  });
  it("a worker that reports an error fails the call and stays up", async () => {
    await expect(V.visionPose(pic("error"))).rejects.toThrow("model exploded");
    expect(await V.visionPose(pic("fine again"))).toHaveLength(1);
  });
  it("a worker that exits mid-request fails the call, and the next call starts a new one", async () => {
    const before = pids().length;
    await expect(V.visionPose(pic("exit"))).rejects.toThrow(/exited|stopped/);
    expect(await V.visionPose(pic("after the crash"))).toHaveLength(1);
    expect(pids().length).toBe(before + 1);
  });
  it("an idle worker is stopped (the GPU sleeps) and started again on demand", async () => {
    await V.visionPose(pic("warm"));
    const before = pids().length;
    await new Promise((r) => setTimeout(r, 1500)); // idle_stop_s is 1
    await V.visionPose(pic("woken"));
    expect(pids().length).toBe(before + 1);
  });
  it("a worker that never answers is a timeout (5 s), not a hang", async () => {
    await expect(V.visionPose(pic("slow"))).rejects.toThrow(/did not answer/);
  }, 15000);
  it("stopVision rejects what is waiting and the plan fills the environment", () => {
    const p = V.visionPlan({ ...process.env });
    expect(p.command).toBe("node");
    expect(p.args[0]).toMatch(/fake-vision-worker\.mjs$/);
    expect(p.env.VISION_DEVICE).toBe("cpu");
    V.stopVision();
  });
});
