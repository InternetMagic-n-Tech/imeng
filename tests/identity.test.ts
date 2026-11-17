import { describe, it, expect, beforeEach } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/identity");
const id = await import("../src/utils/identity.js");
const { seats, _resetSeats } = await import("../src/utils/seats.js");
const { newRoom } = await import("../src/utils/multiplayer.js");

const bea = { userId: "u-bea", name: "Bea" }, disc = { userId: "discord:77", name: "Dee" };
const seq = (...n: number[]) => { let i = 0; return (m: number) => n[i++ % n.length] % m; };
beforeEach(() => { id._resetIdentity(); _resetSeats(); });

describe("link codes", () => {
  it("are 8 characters with no O, I, L, 0 or 1", () => {
    for (let i = 0; i < 200; i++) { const c = id.makeCode(); expect(c).toMatch(/^[A-HJKMNP-Z2-9]{8}$/); }
    expect(id.ALPHABET).not.toMatch(/[OIL01]/);
    expect(id.makeCode(seq(0, 1, 2))).toBe("ABCABCAB");
  });
  it("links two accounts once, in either order of use", async () => {
    const code = id.issueCode(disc, 1000);
    expect(await id.redeemCode(code.toLowerCase(), bea, 2000)).toEqual({ ok: true, name: "Dee", already: false });
    expect(id.canonical("u-bea")).toBe("discord:77");
    expect(id.canonical("discord:77")).toBe("discord:77");
    expect(id.accountsOf("u-bea").sort()).toEqual(["discord:77", "u-bea"]);
    expect(await id.redeemCode(code, bea, 2100)).toEqual({ ok: false, reason: "bad" }); // single use
  });
  it("expires, and a new code replaces the person's old one", async () => {
    const a = id.issueCode(disc, 0);
    expect(await id.redeemCode(a, bea, 10 * 60000 + 1)).toEqual({ ok: false, reason: "bad" });
    const b = id.issueCode(disc, 20 * 60000);
    const c = id.issueCode(disc, 20 * 60000 + 5);
    expect(await id.redeemCode(b, bea, 20 * 60000 + 6)).toEqual({ ok: false, reason: "bad" });
    expect((await id.redeemCode(c, bea, 20 * 60000 + 7)).ok).toBe(true);
  });
  it("reports linking the same person twice, and locks after too many wrong codes", async () => {
    expect((await id.redeemCode(id.issueCode(disc, 0), bea, 1)).ok).toBe(true);
    expect(await id.redeemCode(id.issueCode(disc, 5), bea, 6)).toEqual({ ok: true, name: "Dee", already: true });
    for (let i = 0; i < 3; i++) expect(await id.redeemCode("WRONGONE", { userId: "x", name: "X" }, 10 + i)).toEqual({ ok: false, reason: "bad" });
    expect(await id.redeemCode("WRONGONE", { userId: "x", name: "X" }, 20)).toEqual({ ok: false, reason: "locked" });
    expect(await id.redeemCode(id.issueCode(disc, 30), { userId: "x", name: "X" }, 31)).toEqual({ ok: false, reason: "locked" });
    expect((await id.redeemCode("WRONGONE", { userId: "x", name: "X" }, 10 * 60000 + 100)).ok).toBe(false); // the window passed: counted again from zero
  });
  it("the seat follows the person", async () => {
    seats.set("u-bea", { table: "chat:t", at: 5 });
    await id.redeemCode(id.issueCode(disc, 0), bea, 1);
    expect(seats.get("discord:77")).toEqual({ table: "chat:t", at: 5 });
  });
});

describe("what /link answers", () => {
  it("shows the code in the chat for Open WebUI, and as a direct message for Discord", async () => {
    const owui = await id.linkTurn("", bea, 0, seq(0));
    expect(owui).toBe("Your link code is AAAAAAAA. In your other app send /link AAAAAAAA within 10 min. Anyone who sees it can use it once, so do not post it in a channel.");
    const d = await id.linkTurn("", disc, 0, seq(1));
    expect(d).toMatch(/^I sent you a link code in a direct message\.<dm>.*BBBBBBBB.*<\/dm>$/s);
    expect(await id.linkTurn("BBBBBBBB", bea, 5)).toBe("Linked: this account and Dee are now the same player.");
    expect(await id.linkTurn("nope", bea, 6)).toBe("That code is not valid or has expired.");
  });
});

describe("a table follows a linked player", () => {
  it("re-keys the player, their lines and the confirmations", async () => {
    const room = newRoom();
    room.players["u-bea"] = { userId: "u-bea", name: "Bea", actor: "user", lastSeen: 1 };
    room.players["u-bo"] = { userId: "u-bo", name: "Bo", actor: "p_bo", lastSeen: 1 };
    room.order = ["u-bea", "u-bo"];
    room.talk = [{ userId: "u-bea", text: "hi" }]; room.confirmed = ["u-bea"]; room.awaiting = ["u-bea", "u-bo"]; room.notes = [{ userId: "u-bea", text: "n" }];
    await id.redeemCode(id.issueCode(disc, 0), bea, 1);
    id.rekeyRoom(room);
    expect(room.order).toEqual(["discord:77", "u-bo"]);
    expect(room.players["discord:77"]).toMatchObject({ userId: "discord:77", actor: "user" });
    expect(room.players["u-bea"]).toBeUndefined();
    expect([room.talk[0].userId, room.confirmed[0], room.awaiting[0], room.notes[0].userId]).toEqual(Array(4).fill("discord:77"));
  });
  it("keeps the earlier one when both accounts had already joined", async () => {
    const room = newRoom();
    room.players["u-bea"] = { userId: "u-bea", name: "Bea", actor: "user", lastSeen: 1 };
    room.players["discord:77"] = { userId: "discord:77", name: "Dee", actor: "p_dee", lastSeen: 1 };
    room.order = ["u-bea", "discord:77"];
    await id.redeemCode(id.issueCode(disc, 0), bea, 1);
    id.rekeyRoom(room);
    expect(room.order).toEqual(["discord:77"]);
    expect(room.players["discord:77"].actor).toBe("p_dee");
  });
});
