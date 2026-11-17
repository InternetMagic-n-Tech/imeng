# HOW_TO_TEST.md (Backrooms)

Live test = real narrator model + the CPU judge, a scripted player, a throwaway copy of the game. Same setup and driver as `imengs/lighthouse/HOW_TO_TEST.md` sections 1, 2 and 4 (one model, one server at a time, port 3010, clean up after), with these differences:
- Copy `imengs/backrooms/` instead of `imengs/lighthouse/` (`T=/tmp/br-test`).
- `KNOBS`: `compact` (compaction at 3500 tokens), `wrap` (wrap-up at 6000, compaction off), `exit` (`exit_when` level `gte` 2, so two seams end the game).
- Driver: `MSGS` is a JSON array of player messages; the first must be `Imeng: Backrooms`.

## What to check (read `run.json`, `log.jsonl`, `server.log`)
Opening messages used: `A="Imeng: Backrooms"`, `B="I'm Sam. I'm afraid of something large that I can't see all of. Bright white empty light scares me most. I'm red-green colour blind and sensitive to flickering lights."`

| Check | Setup | Expect |
|---|---|---|
| Trigger | `[A]` and `["Imeng: Backroms"]` | both start the game; the reply asks name, fear, dark vs bright, accessibility; starts nothing |
| Record | `[A,B]` | `actors.user`: name Sam, `fears` has the large creature, `light_fear` "bright", `accessibility` has colour blind and flicker; nothing invented |
| Vague answers | `[A,"Sam. Not sure."]` | the narrator picks something sensible and says what; nothing the player didn't say is recorded as theirs |
| Accessibility honoured | `[A,B]` + 6 exploring turns | grep replies for colour words (`red`, `green`, `yellow`, `blue`, `beige`, `orange`, `brown`, `purple`, `pink`): none used to carry information; no strobing, flashing or flickering text |
| Light fear | `[A,B]` vs a dark-fear opening | bright: too-even white light is the threat; dark: lights drop out and dark is the threat |
| Entity from fear, never named | any, 8+ turns | the entity echoes the stated fear (size, manner) but is never shown whole, and the narrator never says it was chosen for them; `grep "afraid\|your fear"` in replies: none |
| Noise | explore, then "I run and shout" | the place reacts (entity near); noise falls after hiding or waiting; no number or "noise/level/hp" in prose |
| Evasion | after noise is high | a puzzle or a roll, a failure costs hp (max 3), the entity never kills in one blow |
| Moving on | find a seam | `level` +1 at most per turn, hum thins and the place changes |
| Stop request | `[A,B,...,"Please no creatures or monsters at all, just empty rooms."]` | honoured at once, no comment, later turns keep to it; `avoid` holds it |
| No leaks | any | no `CURRENT GAME STATE`, `STATE NOTES`, `STORY SO FAR`, `WRAP UP`, `"actors"`, `(d20:` |
| Picture | start the server (or the hub) with the real game folder | the log prints `.../icons/backrooms-game`; `curl -s -o /dev/null -w '%{http_code} %{content_type}' <that address>` gives `200 image/jpeg`; the doctor has no `icon` finding |
| Ending (out) | `KNOBS=exit`, find two seams | handover to a quiet ordinary place, then `over_reply` |
| Ending (hp) | repeated reckless noise | `hp` reaches 0, gentle non-graphic ending, then `over_reply` |
| Compaction / wrap | `KNOBS=compact` / `wrap` | as in the lighthouse guide |
| Rule audit | any | few or no `rule audit` notices; roles `rule_audit`/`rule_confirm` |

## Monster, chase and credits (added 1.3.0)
| Check | Setup | Expect |
|---|---|---|
| Default monster | `[A,B]`, no monster described | the narrator says it picked the tall, thin, lanky one; `actors.user.monster_size` `taller`; `actors.monster.description` matches |
| Own monster | `[A, B + " My monster is a small girl who crawls, like The Grudge."]` | `monster` holds it, `monster_size` `smaller`, mirrored on `actors.monster.description` |
| Size used against it | 6 turns with a `taller` and a `smaller` monster | the place offers gaps/vents (taller) or stairs/ledges (smaller) and rewards using them; never as a number |
| Chase | noisy turns | `monster_distance` falls at most 2 a turn; at 0 the game ends (`caught by the monster`), non-graphic |
| Injury | "I run round the corner" into a pit | `injury` 1-2, the player is slower afterwards, rest eases it |
| Hazard doors | open a wrong door | fall, lava or water; drowning costs hp; the door is a plain door again once out of sight |
| Picture | `/portrait monster` (needs the renderer; see docs/IMAGES.md) | a picture of the monster from its description; the seed is kept for later pictures |
| Credits | reach the end | the finale, then the text of `CREDITS.md` unchanged; the next message gets `over_reply` |

## Known limits
- The 1.3.0 monster/chase/credits rules are covered by `tests/backrooms-imeng.test.ts` (fake models); not run live yet.
- Run live (gemma4:26b, 3 runs): trigger incl. the misspelling, record of fear/light/accessibility, no colour words and no flicker text for a red-green colour blind and flicker-sensitive player, entity implied and never named, a dark-fear and a bright-fear opening, a vague answer, stop request honoured and recorded in `avoid`, one level change, no leaks. Not run live: `exit` / hp endings, compaction, wrap-up, evasion rolls with real hp loss, a bare dark-vs-bright comparison on the same fear.
- Driver gotcha: the driver reads the first session on the server, so restart the server and delete `saves` between runs, or every turn waits out its 5-minute timeout.

Last database migration: 006_credit
