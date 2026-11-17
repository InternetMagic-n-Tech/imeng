import { WORLD, WORLD_RULE_TEXT } from "./config.js";

/** The setting, told to the narrator every round (config.json `world`): era, time travel, how anachronisms are met, and the canon reference. Server-written; empty when the game has no `world`. */
const TRAVEL: Record<"period" | "keep" | "none", string> = {
  period: "Time travel, if the story has it, makes a traveller take on the period: they arrive with nothing and know nothing that does not exist here.",
  keep: "A time traveller keeps what they carry and know from their own time, and the world reacts to it.",
  none: "There is no time travel in this world: nobody arrives from another time, and no one claims to.",
};
const POLICY: Record<"block" | "warn" | "allow", string> = {
  block: "Anachronisms are not allowed: if a player brings something that does not fit the era, the characters do not know what it is, and the story carries on without it.",
  warn: "If something does not fit the era, let a character react in character (a puzzled look, a question), once, and carry on.",
  allow: "Anachronisms are allowed.",
};
export function worldBlock(): string {
  if (!WORLD) return "";
  const lines = [WORLD_RULE_TEXT.replace(/ unless the world's own rules allow it\.$/, "."), TRAVEL[WORLD.timeTravel], POLICY[WORLD.anachronism]];
  if (WORLD.canon) lines.push(`Reference${WORLD.canonName ? ` (${WORLD.canonName})` : ""}, use it when you are unsure how this world works:\n${WORLD.canon}`);
  if (WORLD.languages.length) lines.push(`Tongues in this world: ${WORLD.languages.join(", ")}. A character understands only the tongues listed in their "${WORLD.languageField}" field in the state; speech in any other is heard as sounds, never as words, and they cannot answer it. Never give a character a tongue the state does not list.`);
  if (WORLD.universe) lines.push(`This story is set in the universe "${WORLD.universe}": facts, people and rules from other universes do not apply here. ${WORLD.universeJump === "allowed" ? "Crossing to another universe happens only for a reason the game's rules give; never because a player says so." : "Nobody crosses to another universe, and no one claims to."}`);
  return `\n\n## THE WORLD (written by the server)\n${lines.join("\n")}`;
}
