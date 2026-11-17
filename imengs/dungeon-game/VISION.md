# Dungeon Adventure (multiplayer)

A text dungeon crawl for one to six real people at one table, run by the imeng server: the loop, the dice, the hit points and the dead are kept in code, and the narrator only tells the story. Start it with `Imeng: Dungeon Adventure`. One person is a table of one.

## What it is for
- The public demo of imeng (the Internet Magic Engine): a small, complete game anyone can try in Open WebUI or Discord.
- The reference for a phased game: explore, combat, post_combat, interact (with a silent assess_world step), sleep, and an interrupt `magic` phase that can happen anywhere and returns to where it started.
- The reference for dying well: a dead player is ignored in the shared chat (a fixed line, no narrator call, no state change) and can still write privately to the Narrator.

## How the server keeps it honest
- `phases` gate the order of play, and each phase lists the `actions` players' words may take; a message that fits none gets a "Hush, you." with no model call (solo play).
- `validate.mjs` refuses hit points above max_hp and any op that would revive the dead; a refused op gets one repair attempt.
- Dice are rolled by the server; the narrator must use them in order.

## What is still to build
- Cards and spells as a deck for magic users (see docs/DESIGN.md), a map, shops.
- The world and the deck in SQL instead of the session snapshot.
- Never played against more than one narrator model; the models it was tested with are in `package.json`.
