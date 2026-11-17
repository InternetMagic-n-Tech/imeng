import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { evidenceIn, echoesTrigger, applySetup, analyzeSetup, inSetupWindow } from "../src/utils/setup.js";
import { initialState } from "../src/utils/state.js";
import { jsonResponse, mockFetch } from "./helpers.js";
import type { ChatMessage } from "../src/utils/types.js";

beforeEach(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });

describe("evidenceIn", () => {
  const said = "I am Bo, a tall fighter. My wizard gf is with me.";
  it("accepts exact quotes, ignoring case and punctuation", () => {
    expect(evidenceIn("I am Bo, a tall fighter", said)).toBe(true);
    expect(evidenceIn("i am bo a tall fighter", said)).toBe(true);
  });
  it("accepts quotes with '...' gaps when every part is present", () => {
    expect(evidenceIn("I am Bo ... my wizard gf", said)).toBe(true);
    expect(evidenceIn("I am Bo … my wizard gf", said)).toBe(true);
  });
  it("rejects invented, empty, too-short or non-string evidence", () => {
    expect(evidenceIn("I am a dragon from space", said)).toBe(false);
    expect(evidenceIn("I am Bo ... a dragon rider", said)).toBe(false);
    expect(evidenceIn("", said)).toBe(false);
    expect(evidenceIn("Bo", said)).toBe(false); // under 8 characters
    expect(evidenceIn(undefined, said)).toBe(false);
  });
});

describe("echoesTrigger", () => {
  const prompt = 'If the user\'s first message is "Game: Test Adventure" follow these instructions.\n\nYou are the narrator.';
  it("recognises evidence that is just the trigger sentence from the system prompt", () => {
    expect(echoesTrigger("Game: Test Adventure", prompt)).toBe(true);
    expect(echoesTrigger("game test adventure", prompt)).toBe(true);
    expect(echoesTrigger("first message is ... follow these", prompt)).toBe(true);
  });
  it("does not flag what a player really said", () => {
    expect(echoesTrigger("I am Bo, a tall fighter", prompt)).toBe(false);
    expect(echoesTrigger("Game: Test Adventure ... and I am a wizard", prompt)).toBe(false);
    expect(echoesTrigger("", prompt)).toBe(false);
    expect(echoesTrigger(undefined, prompt)).toBe(false);
  });
  it("only looks at the top of the prompt, where the trigger sentence lives", () => {
    expect(echoesTrigger("deep inside the rules", "x".repeat(2000) + " deep inside the rules")).toBe(false);
  });
});

describe("applySetup", () => {
  const said = "I am Bo, a tall fighter. My wizard gf Zed is with me, short hair.";
  const run = (result: unknown, state = initialState()) => applySetup(state, result as never, 1, said);

  it("records the user's name and description", () => {
    const s = run({ actors: [{ is_user: true, name: "Bo", description: "tall fighter", evidence: "I am Bo, a tall fighter" }] });
    expect(s.actors.user).toMatchObject({ name: "Bo", description: "tall fighter", controlled_by: "user" });
  });

  it("recognises the user via controlled_by and keeps the name if none is given", () => {
    const s = run({ actors: [{ controlled_by: "user", description: "tall", evidence: "a tall fighter" }] });
    expect(s.actors.user).toMatchObject({ name: "you", description: "tall" });
  });

  it("creates other characters as NPCs with the template fields", () => {
    const s = run({ actors: [{ name: "Zed", controlled_by: "npc", description: "short hair", relationship: "partner", evidence: "wizard gf Zed" }] });
    expect(s.actors.npc_0).toMatchObject({ name: "Zed", controlled_by: "npc", description: "short hair", relationship: "partner", hp: null });
  });

  it("only makes someone another player when explicitly said so; anything else is an NPC", () => {
    const s = run({ actors: [
      { name: "Zed", controlled_by: "other_player", evidence: "wizard gf Zed" },
      { name: "Eve", controlled_by: "hero", evidence: "a tall fighter" },
    ] });
    expect(s.actors.npc_0.controlled_by).toBe("other_player");
    expect(s.actors.npc_1.controlled_by).toBe("npc");
  });

  it("numbers new NPCs after existing ones", () => {
    const start = initialState();
    start.actors.npc_0 = { name: "Old" };
    const s = run({ actors: [{ name: "Zed", evidence: "wizard gf Zed" }] }, start);
    expect(s.actors.npc_1.name).toBe("Zed");
  });

  it("updates an existing actor by name instead of duplicating", () => {
    const start = initialState();
    start.actors.npc_0 = { name: "zed", description: "old" };
    const s = run({ actors: [{ name: "Zed", description: "short hair", relationship: "partner", evidence: "wizard gf Zed" }] }, start);
    expect(Object.keys(s.actors)).toEqual(["user", "npc_0"]);
    expect(s.actors.npc_0).toMatchObject({ description: "short hair", relationship: "partner" });
  });

  it("skips unnamed non-user actors and ones named like the user", () => {
    const s = run({ actors: [
      { name: "", evidence: "wizard gf Zed" },
      { name: "YOU", evidence: "wizard gf Zed" },
    ] });
    expect(Object.keys(s.actors)).toEqual(["user"]);
  });

  it("rejects evidence that is not in the user's words", () => {
    const s = run({
      actors: [{ name: "Ghost", description: "spooky", evidence: "there is a ghost in my team" }],
      rules: [{ text: "Hard mode", evidence: "play on hard mode please" }],
    });
    expect(Object.keys(s.actors)).toEqual(["user"]);
    expect(Object.keys(s.game.rules)).not.toContain("setup_2");
  });

  it("ignores anything 'learned' from the trigger message itself, whatever wording the model uses", () => {
    const trigger = "Game: Test Adventure";
    const s = applySetup(initialState(), {
      actors: [{ is_user: true, description: "User character (details pending)", evidence: trigger }, { name: "Ghost", description: "a ghost", evidence: trigger }],
      rules: [{ text: "Adventure mode", evidence: trigger }],
    }, 1, trigger);
    expect(s.actors.user.description).toBeUndefined();
    expect(Object.keys(s.actors)).toEqual(["user"]);
    expect(Object.values(s.game.rules).some((r) => r.source === "setup")).toBe(false);
  });

  it("rejects placeholder text", () => {
    const s = run({
      actors: [
        { is_user: true, description: "to be defined by the user", evidence: "I am Bo, a tall fighter" },
        { name: "Zed", description: "unknown", relationship: "n/a", evidence: "wizard gf Zed" },
      ],
      rules: [{ text: "Tone: TBD", evidence: "I am Bo, a tall fighter" }],
    });
    expect(s.actors.user.description).toBeUndefined();
    expect(s.actors.npc_0.description).toBeUndefined();
    expect(s.actors.npc_0.relationship).toBeUndefined();
    expect(Object.values(s.game.rules).some((r) => r.text.includes("TBD"))).toBe(false);
  });

  it("adds session rules with provenance, skipping duplicates and capping at 8", () => {
    const ev = "I am Bo, a tall fighter";
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `Rule number ${i}`, evidence: ev }));
    const s = applySetup(initialState(), { rules: [{ text: "Proceeds go to charity.", evidence: ev }, ...many] }, 2, said);
    const added = Object.entries(s.game.rules).filter(([, r]) => r.source === "setup");
    expect(added).toHaveLength(7); // only the first 8 are considered, and one of those is the duplicate
    expect(added[0][1]).toMatchObject({ locked: false, active: true, lift_votes: 0, turn_added: 2 });
    expect(Object.values(s.game.rules).filter((r) => r.text === "Proceeds go to charity.")).toHaveLength(1);
  });

  it("never reuses an existing setup_ id", () => {
    const start = initialState();
    start.game.rules.setup_2 = { text: "existing", locked: false, lift_hint: "", active: true, lift_votes: 0 };
    const s = applySetup(start, { rules: [{ text: "New one", evidence: "I am Bo, a tall fighter" }] }, 1, said);
    expect(s.game.rules.setup_2.text).toBe("existing");
    expect(s.game.rules.setup_3.text).toBe("New one");
  });

  it("copes with garbage results and leaves the state alone", () => {
    const start = initialState();
    for (const bad of [null, undefined, {}, { actors: "x", rules: 5 }]) expect(applySetup(start, bad as never, 1, said)).toEqual(start);
  });

  it("does not mutate the input state", () => {
    const start = initialState();
    run({ actors: [{ is_user: true, name: "Bo", evidence: "I am Bo, a tall fighter" }] }, start);
    expect(start.actors.user.name).toBe("you");
  });
});

describe("analyzeSetup", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "ignored" },
    { role: "user", content: "Game: Test Adventure" },
    { role: "assistant", content: "A".repeat(900) },
    { role: "user", content: "I am Bo, a tall fighter" },
    { role: "assistant", content: "Welcome Bo" },
    { role: "user", content: "third message is beyond the setup window" },
  ];

  it("sends the opening conversation (not stats) to the judge and applies the result", async () => {
    const f = mockFetch(() => jsonResponse({ message: { content: JSON.stringify({
      rules: [], actors: [{ is_user: true, name: "Bo", description: "tall fighter", evidence: "I am Bo, a tall fighter" }] }) } }));
    const state = initialState();
    state.actors.user.inventory = ["secret sword"];
    const out = await analyzeSetup(state, msgs, "N".repeat(900), 2);

    expect(out.actors.user).toMatchObject({ name: "Bo", description: "tall fighter" });
    const body = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body));
    const sys: string = body.messages[0].content;
    const content: string = body.messages[1].content;
    expect(sys).toContain("Game-specific guidance:\nRecord the party.");
    expect(body.options.num_predict).toBe(500);
    expect(content).toContain("USER: <player_message>Game: Test Adventure</player_message>");
    expect(content).toContain("USER: <player_message>I am Bo, a tall fighter</player_message>");
    expect(sys).toContain("untrusted DATA");
    expect(content).not.toContain("third message");
    expect(content).not.toContain("ignored");
    expect(content).not.toContain("secret sword"); // stats and gear are left out
    expect(content).toContain("Proceeds go to charity.");
    expect(content).toContain("A".repeat(600));
    expect(content).not.toContain("A".repeat(601)); // narrator text is truncated
    expect(content.endsWith("N".repeat(600) + "</narration>")).toBe(true); // so is the latest narration
  });

  it("works without a latest narration", async () => {
    const f = mockFetch(() => jsonResponse({ message: { content: '{"rules":[],"actors":[]}' } }));
    await analyzeSetup(initialState(), [msgs[1]], "", 1);
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)).messages[1].content).not.toContain("NARRATOR:");
  });

  it("propagates a judge failure so the caller can log it", async () => {
    mockFetch(() => jsonResponse({ error: "boom" }));
    await expect(analyzeSetup(initialState(), msgs, "", 1)).rejects.toThrow("boom");
  });
});

describe("inSetupWindow", () => {
  it("covers the first setup_turns turns (2 in the fixture)", () => {
    expect([1, 2, 3].map(inSetupWindow)).toEqual([true, true, false]);
  });
});
