import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import path from "node:path";
import request from "supertest";

// icon fixture: model id "pic-game" with icon pic.png in the game folder
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/icon");
let app: typeof import("../src/app.js").app;
let bootstrap: typeof import("../src/utils/bootstrap.js").bootstrap;
const logs: string[] = [];

beforeAll(async () => {
  ({ app } = await import("../src/app.js"));
  ({ bootstrap } = await import("../src/utils/bootstrap.js"));
});
beforeEach(() => {
  logs.length = 0;
  jest.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the game's picture", () => {
  it("is served at /icons/<model_id> without a key", async () => {
    const res = await request(app).get("/icons/pic-game");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body.toString()).toBe("PNGDATA");
  });
  it("is not served for another model id", async () => {
    expect((await request(app).get("/icons/other")).status).toBe(404);
  });
  it("has its address logged at start, built from PUBLIC_URL", async () => {
    const server = await bootstrap({ preflight: false, port: 0 });
    expect(logs.join("\n")).toMatch(/Game picture: http:\/\/localhost:\d+\/icons\/pic-game/);
    await new Promise((r) => server!.close(r));
  });
  it("stays quiet at start when the game runs under the hub", async () => {
    process.env.IMENG_HUB_CHILD = "1";
    const server = await bootstrap({ preflight: false, port: 0 });
    delete process.env.IMENG_HUB_CHILD;
    expect(logs.join("\n")).not.toMatch(/Game picture/);
    await new Promise((r) => server!.close(r));
  });
});
