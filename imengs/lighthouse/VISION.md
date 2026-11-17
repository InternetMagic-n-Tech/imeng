# The Lighthouse: vision

**What it is.** A slow, lonely, single-player horror at the end of the world: a sole keeper, a haunting, bad weather, short days. About what isolation does to time, sleep and sanity.

**Fixed length, flexible days.** The posting is a fixed number of turns (`wrap_up.at_turn`), not a fixed number of days. When nothing happens for days in a row the narrator advances the calendar itself in one short summary (never past a spook that should break the quiet), so a quiet stretch costs one turn, not ten. The relief boat comes on the last turn.

**Themes.** Sanity, time and isolation. Substance abuse and being alone are themes of the story, not a feature: drink, pills or fumes are an option the game never offers and never moralises about; it is switched on in config.json (default off) and, when on, the player has to bring it up themselves and it only dulls the nights and costs the mornings. Nothing is shown in detail.

**What keeps the keeper well.** Comforts: plants, shells, a carved thing, a terrarium or any inert object that reminds them of something pleasant, which they keep, tend and add to; each raises nerve. Walks: the keeper can go outside, explore the desolate shore, inspect the small island, and bring things back to the lighthouse, where they can become comforts.

**The wreck.** Sometimes someone is shipwrecked. The keeper can help. A badly haunted keeper may feel a strong need to keep them safe: that care is a way back to nerve, and also a risk if they are too frightened to leave them alone. Never a lecture, never a rescue the player did not choose.

**What it shows off.** Server-owned day, depth, gloom, nerve, with `limits` and `decrease_locks`; `field_words`; day-skips with a rule that spooks break them; the haunting never explained; locked session rules and the audit; the optional-substances switch; `comforts`.

**To build.** The turn budget in place of the fixed 120 days; narrator-led skips when nothing happens; the substance option as a config.json enum (default off); outdoor walks and island places; the shipwrecked person as a named NPC with its own rules.

**Done when.** A run reaches the last turn with a calendar that moved at the story's pace, a keeper who found something to care for, and nothing in the text that treats the substance option as a reward.
