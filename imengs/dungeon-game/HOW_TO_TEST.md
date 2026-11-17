# How to test: Dungeon Adventure (multiplayer)

- Doctor: `IMENG_PATH=imengs/dungeon-game npm run doctor` (game-config must be ok).
- Live: `IMENG_PATH=imengs/dungeon-game SAVE_DIR=/tmp/dungeon PORT=3010 npm start`, then `Imeng: Dungeon Adventure` as the first message. For a table, share the chat in Open WebUI with "Allow replies" and let a second person speak.

| Check | What to do | Expected |
|---|---|---|
| Trigger | first message `Imeng: Dungeon Adventure` | the narrator welcomes the table and asks who the adventurers are |
| Intro / direct mode | (not applicable: this game sets `invocation: "always"`, so every first message starts the game) | |
| Phases | explore, start a fight, win it | `imeng.phase` goes explore, combat, post_combat, explore |
| Hush (solo) | in combat, ask "what's for lunch?" | "Hush, you." with no narrator call; the state is unchanged |
| Interact | talk to a prisoner, then walk away | explore, interact, (silent assess_world), explore |
| Magic | cast a spell during exploring or have an enemy cast one | phase becomes magic, then returns to the phase it interrupted |
| Hit points | take damage, then heal above max | hp never goes above max_hp (the validator refuses it) |
| Death | let a player reach 0 hp at a two-player table | that player's shared-chat messages get "You are dead..." and change nothing; their private chat still works |
| Party size | seat seven people | the seventh is told the table is full |
| Everyone dead | all players at 0 hp | `imeng.phase` ends in ended |
| MLflow | with MLFLOW_TRACKING_URI set, play a turn | the trace is tagged `imeng`; `ops.repair` and `off_phase` spans show when they happen |

Last database migration: 006_credit

Result (2026-11-16, gemma4:26b, judge actbro/minicpm5-2b-jev, one player Newt plus two NPC companions, 13 turns, direct to the proxy): setup, explore, combat and post_combat reached in order; before the fix the off-phase gate hushed real combat actions ("Eyes on the dungeon.") because the 2B judge answered `attack` instead of the listed `fight` (`actionFits` in `src/utils/gate.ts` now maps a word from the action's description, or the one action of a phase); after it attacks narrated in combat. Not covered: hp above max (the validator), death, a table of 2 to 6 people, a magic ruling, a card draw. Seen: a companion's hp stayed null in state and a heal by Elara was narrated but Newt's hp stayed 7 (the extractor did not apply it).
