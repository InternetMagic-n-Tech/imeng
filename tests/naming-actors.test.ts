import { describe, it, expect } from "@jest/globals";
import path from "node:path";

process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/naming");
const { nameActors } = await import("../src/utils/naming.js");

describe("nameActors", () => {
  it("names an unnamed NPC, never the user or a named one, and never repeats a name", async () => {
    const st: any = { game: {}, actors: {
      user: { name: "Bea", controlled_by: "user", role: "contestant" },
      npc_a: { name: "", controlled_by: "npc", role: "contestant" },
      npc_b: { name: "", controlled_by: "npc", role: "contestant" },
      npc_host: { name: "", controlled_by: "npc", role: "host" },
      table: { name: "", controlled_by: "npc" } } };
    await nameActors(st, async () => "Priya");
    expect(st.actors.user.name).toBe("Bea");
    expect(st.actors.npc_a.name).toBe("Priya");
    expect(st.actors.npc_b.name).not.toBe("Priya"); // asked again, then the code's own list
    expect(st.actors.npc_b.name).toMatch(/^[A-Z][a-z]+/);
    expect(st.actors.npc_host.name).toBe(""); // role not in roles
    expect(st.actors.table.name).toBe("");
  });
});

describe("the reserved name pool", () => {
  it("fills to the pool size with clean unlike names, and drops names that have been taken", async () => {
    const { refillPool, poolBlock } = await import("../src/utils/naming.js");
    const names = ["Priya", "Marcus", "Lena", "Omar"];
    const session: any = {};
    const st: any = { game: {}, actors: { user: { name: "Bea", controlled_by: "user" } } };
    const pool = await refillPool(session, st, async () => names.shift());
    expect(pool).toEqual(["Priya", "Marcus", "Lena"]);
    expect(poolBlock(pool)).toContain("Priya, Marcus, Lena");
    st.actors.npc_a = { name: "Priya", controlled_by: "npc" };
    const next = await refillPool(session, st, async () => names.shift());
    expect(next).toEqual(["Marcus", "Lena", "Omar"]); // Priya was taken; one new name drawn
  });
});
