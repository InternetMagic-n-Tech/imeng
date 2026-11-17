import { describe, it, expect } from "@jest/globals";
import path from "node:path";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/vision-fake");
process.env.NODE_ENV = "production";
const V = await import("../src/utils/vision.js");

describe("the vision module in production", () => {
  it("never spawns a worker without vision.url", async () => {
    await expect(V.visionPose(Buffer.from("a person"))).rejects.toThrow(/production: the vision worker is expected at vision\.url/);
    await expect(V.visionCensor(Buffer.from("a picture"))).rejects.toThrow(/production/);
  });
});
