import { describe, it, expect, jest } from "@jest/globals";

const ping = jest.fn(async () => "PONG");
const destroy = jest.fn();
const client = { on: jest.fn(), connect: jest.fn(async () => {}), ping, destroy, disconnect: jest.fn() };
jest.unstable_mockModule("redis", () => ({ createClient: jest.fn(() => client) }));

const { realSys } = await import("../src/utils/doctor-sys.js");

describe("realSys.redisPing", () => {
  it("connects, pings and always cleans up the connection", async () => {
    expect(await realSys().redisPing("redis://fake")).toEqual({ ok: true });
    expect(ping).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it("returns the error and still cleans up when the ping fails", async () => {
    ping.mockRejectedValueOnce(new Error("NOAUTH Authentication required"));
    expect(await realSys().redisPing("redis://fake")).toEqual({ ok: false, error: "NOAUTH Authentication required" });
  });

  it("falls back to disconnect() on older clients, and ignores cleanup errors", async () => {
    const old = { ...client, destroy: undefined as undefined, disconnect: jest.fn(() => { throw new Error("already closed"); }) };
    const { createClient } = await import("redis");
    (createClient as unknown as jest.Mock).mockReturnValueOnce(old);
    expect(await realSys().redisPing("redis://fake")).toEqual({ ok: true });
    expect(old.disconnect).toHaveBeenCalled();
  });
});
