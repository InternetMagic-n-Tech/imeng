# Game files, state and `config.json`

## Game files

A game lives in `IMENG_PATH` (default `./imengs/dungeon-game`). Its settings are `config.json`, or `config.mjs` when you want comments, shared pieces or conditions: an ES module whose default export is the settings object (or a function returning it, sync or async). `config.mjs` wins when both exist; `npm run build:prompts` (the driver's `build`) only builds prompt templates; the proxy, the Discord bridge and `db:migrate --all` all read `config.mjs`, then `config.ts`, then `config.json` with the same loader. Helper code a game loads (`validate`, `evict`, `phases.hook`) lives in the imeng's `hooks/` folder (`"validate": "hooks/validate.mjs"`). `config.ts` also works under `npm run dev` and in tests, but a built server cannot import TypeScript, so ship `.mjs` or `.json`. `imengs/dungeon-game` is the plain JSON example.

| File | Purpose |
|---|---|
| `SYSTEM_PROMPT.md` | The narrator / host / game-master instructions. Required (falls back to `./SYSTEM_PROMPT.md`, then a built-in default). |
| `config.json` | Optional configuration (below). |
| `package.json` | Optional. `version` (semver, bump once per session of changes, by the largest kind) is read by the engine only to stamp each save with the game version it began under (a save from another major version gets a warning at startup); `proxy_version`: the proxy `version` (root `package.json`) the game was tested on; and `models`: the narrator and judge (name + digest) the game was tested with. |

### `config.json`

The file is checked at startup against one schema (`src/utils/config-schema.ts`): a wrong type stops the start with the key path, an unknown key (usually a typo) only warns. `npm run schema` writes `imeng.schema.json`; put `"$schema": "../../imeng.schema.json"` (path to it) at the top of a `config.json` and an editor will autocomplete and flag mistakes.

| Key | Default | Meaning |
|---|---|---|
| `schema_version` | `1` | Format version of this file. The engine refuses a higher number than it knows and upgrades an older one in memory (with a warning). See `docs/IMENG-MAKING.md`, "Migrating". |
| `model_id` | `text-game` | Name shown in Open WebUI's model list. |
| `icon` | none | An image file in the game folder (png, jpg, webp or gif, up to 2 MB). Served without a key at `/icons/<model_id>` (base: `PUBLIC_URL`) and its address is logged at start (the hub logs it for every game). Open WebUI takes a model's picture from its own Workspace entry, not from the connection, and its model editor only accepts an uploaded file: upload this file once (Workspace > Models > the model > click the picture). The address is for scripts and browsers. The doctor checks the file. |
| `initial_state` | `{}` | Starting state. `game` and `actors` are filled in if missing; `actors.user` always exists. |
| `actor_template` | `{name, statuses, history}` | Fields given to new actors (`add_actor`). |
| `actor_history_limit` | `20` | Max entries kept in each actor's `history`. `history_limit` is the v1.1 name and still works (the doctor warns). |
| `private_guidance` | none | How the actors of this game use the private channel (`<private>`, private chats), in words. The judge that decides who a private message is for, and the narrator on any round with a private part, are told it. See docs/IMENG-MAKING.md, "Private text". |
| `private_only_reply` | `...` | What the player sees when the narrator's whole reply was inside `<private>...</private>`, e.g. `The Host makes notes.`. config.json only: it is not a state field, so no model can change it. See docs/IMENG-MAKING.md, "Private text". |
| `too_long_reply` | plain English line | What the player is told (HTTP 413) when a message makes the prompt bigger than `CONTEXT_MAX_TOKENS`. Nothing is saved; they edit and resend. |
| `phases` extras | none | Phases also take `actions` (`{name: {describe, allow: [paths]}}`: only those paths may change while the phase lasts), `silent` (passes through in the same turn), `interrupt` (can be entered from anywhere; `"next": ["@return"]` goes back to the phase it interrupted). `off_phase: {...}` gives a fixed hush reply (solo only) when a message does not fit the phase. See `docs/IMENG-MAKING.md`, "Loops and gates". |
| `validate`, `repair` | none | `validate: "hooks/validate.mjs"` loads `validateOp(op, state)` from the imeng folder: an op that breaks the game's own rules is refused, and the repair judge gets one try at a corrected op. See `docs/IMENG-MAKING.md`, "Validators". |
| `tone_fields`, `role_field`, `field_roles`, `write_once` | none | Character voice fields the narrator always sees (never masked by `pii`); which actor field holds a role and which roles a field may change for; fields that lock after their first set. |
| `forfeit` | off | The server sometimes deals one real player a forfeit: send a picture within a few rounds or take a penalty. See `docs/IMENG-MAKING.md`. |
| `world` | off | Era, time travel, canon file, anachronisms, `languages` (who understands which tongue) and `universe`. See `docs/IMENG-MAKING.md`. |
| `dating`, `question`, `show_clock`, `deck` | off | The dating-show rules (directed attraction, discovery, finale pairing), the open-question gate, a TV-format clock, and card luck rolled by code. All in `docs/IMENG-MAKING.md`; the Dungeon uses them. |
| `events_limit` | `30` | Max entries kept in `game.events`. |
| `state_rules` | none | Game-specific bookkeeping hints passed to the state extractor. |
| `limits` | none | Numeric actor field rules: `{"hp": {"min": 0, "max": 10, "max_step": 5}}`. `max_step` is the most a field may change in one turn, however many ops the model proposes. |
| `allowed_values` | none | A field that can only hold one of a fixed list: `{"game.ambient":["cold","mild","hot"],"<actor field>":[...]}`. A `game.<field>` key is a session-wide value; a bare name applies to that field on every actor. `set`, `push` and `add_actor` with another value are rejected (a match in another case is stored as listed). `initial_state` is not checked. The extractor is told the allowed values. |
| `field_evidence` | none | An actor field that changes only when the narrator's own words contain a phrase: `{"score":"\\bpoints? (?:goes )?to {name}\\b"}` (a case-insensitive regular expression; `{name}` is the actor's name, `address_as` or id). The player's words never count, and a change the narration does not support is dropped (logged as `dropped (field_evidence)`), not retried. Use it for a field the extractor tends to over-award, such as a score: tell the narrator the fixed sentence in the prompt. |
| `sticky_fields` | none | Hard-to-change fields: `{"game.ambient":2}`. A `set` to a new value takes effect only when the same value is set on that many turns in a row; a turn that doesn't repeat it drops the proposal, and the narrator never sees pending changes (they sit in the server-owned `game.pending`). A field that is still empty takes its first value at once. All other checks (`allowed_values`, protected paths) run first. The extractor is told which fields are sticky. Say in the prompt who may change it (for example only the narrator's own account of events). |
| `unique_fields` | none | Actor list fields that act as sets: `["ground_rules","statuses"]`. A `push` of an entry already there does nothing (the first entry stays; case and extra spaces are ignored), `remove` matches the same way, and repeats already in a saved game collapse to the first. Other lists keep duplicates. Use a number, not a list, for anything that counts stacking or can be undone one step at a time. |
| `decrease_locks` | none | Ordering rules: `[{"field":"stain","while":{"field":"glow","gt":0},"reason":"..."}]` (`while` takes `gt`, `gte`, `lt`, `lte` or `eq`). A field can't go down in a turn that *started* with the `while` condition true, so a cleaning that needs a coating gone first can't be skipped by doing both in one reply; the next turn it works. Code keeps the old value, logs a warning, and tells the narrator in the next turn's STATE NOTES that the change did not happen (the server-owned `game.blocked` list, kept for one turn). Leave `while` out and the field can never go down (a day counter: `{"field":"day"}`). Tell the narrator the order in the prompt too. |
| `exit_group_when` | none | End the game for everyone still in when a condition holds: `[{"field":"warmth","lte":2,"share":1,"reason":"all frozen"}]`. A plain comparison (`lt`, `lte`, `gt`, `gte`, `eq`) needs `share` (0-1, default 1 = all) of the actors still in (not exited) to meet it; `lte` and `gte` alone mean either. Or a condition tree, see "Condition trees". Checked every turn in code. |
| `exit_when` | none | Auto-exit actors: `[{"field":"hp","lte":0,"reason":"died"}]`. Same conditions as `exit_group_when` (a plain comparison reads that actor's field; no `share`). |
| `early_sync` | `false` | Read the player's own message into the state while the narrator is still writing (one extra extractor call per turn, run in parallel), so what they stated (name, ground rules, place) is in the record when the reply ends; the narration is read afterwards as usual. On one GPU with `OLLAMA_NUM_PARALLEL` 1 the early call queues with the narrator and can delay the first words; it pays off when the extractor model can run alongside. A failed early pass changes nothing: the normal sync runs. |
| `reasoning` | `hide` | `hide` strips the model's thinking from the stream, `show` forwards it, `off` sends `reasoning_effort: "none"`. |
| `hide_state_echo` | `false` | The narrator is told the state and dice privately. If it repeats those blocks (the `CURRENT GAME STATE`, `DICE` or `SESSION RULES` sections, a fenced JSON dump of the state, or bare `{"op":...}` lines), the proxy removes them from the stream and from what is recorded. Off by default so a game's output is never changed unasked; a game turns it on with `state_notes`. |
| `alias_fields` | none | Actor fields that hold another name a person goes by, e.g. `["address_as"]`. They count as the person's name in the recap's "names every person" check, and an actor the model adds under one of those names in the same turn is dropped as a duplicate (the recorder tends to treat "call me Dr. Okafor" as a new person). |
| `state_notes` | `false` | Adds a plain-language **STATE NOTES** block beside the JSON state, written by the server (no model): what the record says changed since the narrator's last turn (numbers, new items, new people, exits). It also adds a **CATCH-UP** (everyone, in words, plus recent events) when the story and the record may be out of step: the saved record was lost, the player regenerated or edited, or bookkeeping failed on an earlier turn. The JSON stays the truth. |
| `field_words` | none | Words for numeric fields, used by the notes: `{"warmth": [[0,"freezing"],[4,"cold"],[8,"warm"]]}` (the word of the highest bound at or below the value). |
| `compaction` | off | `{"at_tokens": 19000, "keep_turns": 6, "max_chars": 2500}`. When the prompt for the next turn is about `at_tokens` (estimated as characters / 4), turns older than the last `keep_turns` are replaced by a **recap** (**STORY SO FAR**) written by the narrator model with its thinking off. See "Compaction" below. |
| `wrap_up` | off | `{"at_turn": 30, "soon_turns": 4, "soon_text": "...", "at_tokens": 26000, "text": "...", "after_text": "...", "over_reply": "...", "credits_file": "CREDITS.md", "on_exit": "user"}`. `credits_file` is a file in the game folder added word for word after the finale (never seen or rewritten by the narrator). `at_turn` is a **turn budget**: the number of player turns your hardware was measured to carry (see "Compaction"); on that turn the narrator is told to close the game, so the ending is the server's call, not the model's. `soon_turns` (needs `at_turn`) gives the narrator a **WRAP UP SOON** block with `soon_text` for that many turns before, so the story can wind down. Set at least one of `at_tokens` / `at_turn`. The escape hatch: if the prompt is still over `at_tokens` after compaction, the narrator is told (in your wording) to end the game on that turn, then that the game is over. `turn_budget` (`hard` default, or `after_compaction`): with `after_compaction`, `at_turn` and `soon_turns` are skipped once compaction has written a recap, so only the token limit applies. The `at_turn` / `at_tokens` pair is a **hardware guard**; the game's own story endings are for `turn_events` (below). `on_exit` (`user` or `all`) ends the game the same way when the person typing, or everyone, is out of the game. See "Compaction". |
| `game_turn` | off | `{"advance":"judged","word":"round","rule":"..."}`. A **game turn** is a beat the game defines (a show round, a quarter, a match), apart from the chat round (which stays the key for rollback and edits). `advance`: `round` (default, every round is one), `field` (a game turn passes when the numeric `game.<field>` named in `field` goes up) or `judged` (after each round the judge reads everything said and narrated since the last game turn, public and private, plus the state changes, and decides from `rule` whether one completed; it can also release a timed effect that ended in the story). `word` is what the game calls it (`turn`, `round`, `segment`, `quarter`, `game`, `match`, or any short word) and is how the narrator is told about it. The count is `game.game_turn` (server-owned, rolled back with the state). With game turns on, the extractor may add a timed effect `{"op":"effect","who":"actors.user","text":"wears the hat backward","turns":3}`; code expires it. See docs/IMENG-MAKING.md, "Game turns". |
| `calculated` | none | Values the server works out after every change into `game.calc.<name>`; no op can write them. `{"goals_done": {"count": "actors.*.goals", "where": {"done": true}}, "leader": {"argmax": "goals_done"}}`. `count` per actor; `sum`/`min`/`max` one number; `argmax`/`argmin` an id (`null` on a tie or under `at_least`). Read in conditions as `game.calc.<name>`. See docs/IMENG-MAKING.md. |
| `phases` | none | `{"start": "registration", "registration": {"require": [conditions], "next": "playing", "note": "..."}, "playing": {"enter_when": {}, "exit_when": {}, "next": ["finale"]}, "texts": {"here","missing","blocked"}}`. `game.phase` only moves along `next` when `require` / `enter_when` hold (checked in code); an `exit_when` that holds moves it on. The narrator is told what is missing. Conditions also take `present` and `is`. |
| `goals` | off | Secret goals, optionally with a reason, written in the private channel (a `<private>` note, a private part of a message, or `/goal x because y`), read by a judge, never shown to the extractor. `{"device": "the Notebook", "min": 1, "max": 2, "host": "blind\|own\|all", "reward": "award\|points\|keepsake", "points": 1, "score_field": "score", "capture_phase": "registration", "npc": "invent\|none", "npc_after": 1, "theme": "...", "standings": "end\|always", "reveal": "end\|never", "judge": {"model","url","api","num_ctx"}, "texts": {}}`. The state gets protected counters `goals_set` / `goals_done` that `phases` and `calculated` read. A goal counts only with words that really are in the round. Env `GOALS_JUDGE_MODEL`, `GOALS_JUDGE_URL`, `GOALS_JUDGE_API` give it its own judge. See docs/IMENG-MAKING.md. |
| `turn_events` | none | Needs `game_turn`. A list of `{"id","at"\|"every","if","text","set","end"}`: `at` fires the moment the game turn becomes N (once), `every` on each Nth; `if` is a condition as in `exit_when` (add `"aggregate":"top_count"` to test for a tie at the top); `text` is told to the narrator once, on the next round; `set` is `{"game.field": value}` through the usual checks; `end: true` closes the game: the narrator writes the finale from `text`, then it is over (`wrap_up.after_text` / `over_reply`). State matters as much as text here: an event that only talks changes nothing the next turn can rely on, so use `set` for anything the rules depend on. Not named `events`: `game.events` is already the state's event log. |
| `seating` | off | `{"approval":"owner","phases":["between"],"min_age":21,"default_sexuality":"straight"}`: at a multiplayer table nobody plays without `/seat <age> <gender> [sexuality]` then `/seat yes`; age is 18 or more (and `game.min_age`); only between hands (a yes during a hand is queued); `approval: "owner"` makes the owner `/seat approve` each request. Age is self-declared. See docs/IMENG-MAKING.md. |
| `pay` | off | `{"field":"chips","phases":["between"],"escrow":{"release_on":["dance"]},"texts":{}}`: `/pay <name> <amount>` moves whole chips between two seated real players, by code, only in the listed phases (default any); `escrow` adds `/pay hold`, `/pay release`, `/pay refund`. See docs/IMENG-MAKING.md. |
| `images` | off | Pictures from the chat (`/draw`, `/portrait`) through a renderer you run: `{"renderer":"comfyui","workflow":"workflow.json","prompts":{"style":"...","positive":"...","negative":"..."},"seeds":{"Bo":4242},"reference":{"default":"look.png"},"ask":{"words":["picture"]},"process":{"command":"python","args":["main.py"],"cwd":"${COMFY_DIR}","venv":"${COMFY_DIR}/venv"}}`. `renderer` is `comfyui`, `a1111`, `openai` or `ollama`; a seed is kept per character; a reference may be a file, an attached picture or (if allowed) a URL; the narrator's model is unloaded around a render (the GPU lease). Nothing is drawn without a command or a `yes`. Optional: `state_fields`, `game_fields`, `keep_fields` (recorded values into the prompt), `refine` (a judge, possibly a larger model, rewrites the prompt as tags; `negations` move to the negative prompt), `judge`, and `keepsake` (`/keepsake` after the game for the winner, with `goals.reward: "keepsake"`), and `safety` (`{threshold, labels, uploads, renders}`: the vision module's image censor refuses flagged attached pictures and renders; fails closed; needs the top-level `vision` block). See `docs/IMAGES.md`. |
| `link` | off | Joins one person's accounts (e.g. Discord and Open WebUI) with `/link`: `{"length":8,"style":"chars","ttl":"10m","max_fails":5}` or `"style":"words"` with a `words` list (16+, no hyphens). The code never enters the chat history; Discord users get it by DM and redeem it in a DM with the bot. Codes live in memory only. See `docs/MULTIPLAYER.md`. |
| `freeze` | off | `/freeze` and `/unfreeze` for a player or (with `others:"anyone"`) a character: `{"mode":"skip","catch_up":"public","others":"off"}`. `mode` is `skip` (left out of the scene), `npc` (the narrator plays them) or `inert`; `catch_up` `public` shows what everyone saw while away, never whispers. The table does not wait for a frozen player. See `docs/MULTIPLAYER.md`. |
| `tail_notices` | `false` | Put STATE NOTES, CATCH-UP, WRAP UP and GAME OVER at the **end of the last player message** instead of the system prompt. Measured: with a long system prompt the model ignored them at the head. |
| `enforce_rules` | `false` | After each reply the audit checks it against the active `session_rules` (and, if the game's `judge_actor_fields` include them, each person's own recorded rules). A finding counts only if it quotes the narration verbatim for an existing rule **and a second, separate check confirms it** (both models over-flag on their own). The confirmation must name, word for word, the rule or the person's own recorded rule it says was broken, say that the rule forbids exactly what the quote does, and the code checks that the cited rule really exists. The narrator then gets a one-time **RULE VIOLATION** correction on the next turn. Nothing is blocked or rewritten: the reply has already streamed. Use `rule_audit_with: "main"`: measured with the small judge it flagged ~15 of 16 turns, nearly all false, and the corrections made the narrator over-restrict the player; with the main model (and the confirm step) 0 of 14 turns were falsely flagged, and planted violations were caught. |
| `rule_audit_with` | `judge` | `judge` or `main`: which model audits and confirms. `main` uses the narrator model with thinking off (about 1 s per call). |
| `session_rules` | none | Standing rules that can be lifted (below). |
| `judge_model` | main model | Model that decides whether rules should lift. |
| `judge_api` | `ollama` | How the judge is called: `ollama` (native API) or `openai` (an OpenAI-compatible server such as llama.cpp's `llama-server`: `/v1/chat/completions`, JSON mode, temperature 0). Set `JUDGE_URL` (or it shares the narrator's server) and optionally `JUDGE_API_KEY`; env `JUDGE_API` overrides. Local servers only (rule 3). With `openai` the image lease does not unload the judge. |
| `judge_confirmations` | `2` | Consecutive "lift" verdicts required. |
| `judge_instance` | none | Spawn a dedicated Ollama for the judge (below). |
| `judge_actor_fields` | name, controlled_by, relationship, description, statuses, history | Actor fields the judge may see (stats and gear are left out by default). |
| `judge_history_items` | `5` | Recent history entries per actor shown to the judge. |
| `judge_events` | `10` | Recent plot events (`game.events`) shown to the judge. |
| `invocation` | `judge` | `judge` decides from the first message whether the prompt is invoked; `always` skips the check. |
| `dice` | `false` | `true` makes the server pre-roll the default pool for the narrator each turn; an object sets your own, e.g. `{"d20": 4, "d6": 10}`. |
| `user_id` | `user` | Actor id of the person typing (use `player`, `host`...). |
| `npc_prefix` | `npc_` | Prefix for generated NPC ids (`guest_0`, `guest_1`...). |
| `writable_fields` | any | Allowlist of actor fields the model may change. Everything else is refused (recommended for public games). |
| `actor_ref_fields` | none | More fields that hold an actor id besides `game.current_actor`: `["game.target","rival"]`. A write is checked (an id, or a name the judge matches); the field is cleared when that actor leaves. |
| `refs` | none | Fields that must hold ids of a domain: `{"game.location":{"to":"places"},"actors.*.inventory":{"to":"items"},"actors.*.counts":{"keys_to":"items"}}`. See `docs/MULTIPLAYER.md`, "Ids". |
| `id_domains` | `actors` only | Where things with ids live and how their ids are made: `{"items":{"at":"game.items","mint":{"kind":"counter","prefix":"item_"}}}`; `key` makes it an array of objects, `when` is `creation`, `collision` or `change`. Adds the ops `add` and `drop`. |
| `field_access` | none | Per field `read-only` or `write-only` (`{"game.phase":"read-only","secret":"write-only"}`): ops cannot write a read-only field; the address of a write-only field can never be used as a value. |
| `multiplayer` | off | Several real people at one table: `{"enabled":true,"turns":"ready","tension":{"mode":"beats"},"private":{"reply":"ack"}}`. Turn policies, ordering, away, standing instructions, tension beats, private chats, clock and timeouts: see `docs/MULTIPLAYER.md` and docs/OPERATIONS.md "Multiplayer" below. |
| `knowledge` | off | Facts only some people know (needs `multiplayer`): `{"enabled":true,"leak":"retry","triggers":{"statement":"owner"},"seed":[...]}`. Stored server-side outside the state; the narrator holds a fact only when a knower speaks. Recorded in private chats, revealed by action or confirmed statement. Keys and details: `docs/MULTIPLAYER.md` section 11. |
| `tools` | none | Tools the narrator may call, each with its limits: `{"tmdb":{"max_calls_per_turn":4},"fetch":{"hosts":["api.example.com"]}}`. Built in: `fetch`, `web_search`, `tmdb`, `stock`. Keys and endpoints go in `tools.config.mjs`, never here. See `docs/TOOLS.md`. |
| `tool_rounds` | `3` | How many model-and-tool rounds one turn may take. |
| `sync` | `{"mode":"detect"}` | Keeping the record in step with the conversation: `detect` (default) only fingerprints and logs, `repair` rolls back and replays, `off`. See `docs/DEPLOYMENT.md`. |
| `discord` | `{"scope":"user"}` | How the Discord interface treats the game (read by the bridge): `scope` `user` (everyone has a 1:1 conversation) or `channel` (a shared table), `merge_context`, `history_limit`. See `docs/DISCORD.md`. |
| `trigger_pattern` | English "if/when ... message" | Regular expression that recognises the trigger sentence at the top of the prompt, for prompts in other languages. |
| `placeholder_patterns` | none | Extra regular expressions for placeholder text the setup judge must not record ("por definir"). |
| `prompts` | built-in | Replace the `extractor`, `setup`, `rule_judge`, `rule_audit`, `rule_confirm`, `compaction_extract`, `invocation`, `compactor` or `compaction_judge` prompt entirely (another language or style). The untrusted-data notice is always added. |
| `setup_turns` | `3` | How many opening user messages get analysed for session rules and cast. |
| `setup_hint` | none | Optional designer guidance added to the setup analysis prompt. |


### Condition trees (`exit_when`, `exit_group_when`)
A rule can combine conditions, so a multi-variable ending needs no helper field the narrator must remember to flip:
```json
{ "logic": "AND",
  "conditions": [
    { "aggregate": "avg", "field": "stain", "gte": 6 },
    { "field": "game.round", "gte": 3 }
  ],
  "reason": "the studio is a swamp" }
```
- `logic`: `AND`, `OR` or `NOT` (exactly one condition) around a `conditions` list; trees nest up to 6 deep.
- `aggregate`: `avg`, `min`, `max` or `sum` of `field` over the actors still in, compared with `lt`/`lte`/`gt`/`gte`/`eq` (all given must hold).
- `field: "game.<name>"` reads a number from the shared game state.
- Missing or non-numeric values make a condition false (so `NOT` of one is true). Evaluated by code on the clamped record after each turn; the model never decides. `npm run doctor` checks the shape and flags a group rule already true at the start.

## State

State is plain JSON, kept per session:

```jsonc
{
  "game": {
    "turn": 3,
    "current_actor": "user",          // whose turn it is
    "exited_game": [{ "id": "npc_1", "reason": "died" }],
    "events": ["The ghost forgave the living."],   // plot ledger
    "rules": { /* session rules, server-owned */ }
  },
  "actors": {
    "user":  { "name": "you", "controlled_by": "user", "hp": 7, "statuses": [], "inventory": [], "history": [] },
    "npc_0": { "name": "wizard girlfriend", "controlled_by": "npc", "description": "...", "relationship": "partner" }
    // ids are npc_0, npc_1, ...
  }
}
```

`controlled_by` is `user` (the person typing), `npc` (the narrator voices them) or `other_player` (another real person). The narrator is told never to write the words or actions of `user` / `other_player` actors.

### Compaction

Long games outgrow the model's context window (the chat is re-sent every turn). With `compaction` set, after a turn the server checks the size of what the next turn would send. Over `at_tokens`, it folds the oldest turns into a short recap and stops sending them; the last `keep_turns` stay in full.

The recap never writes state. It is used only if it passes checks the narrator model doesn't control:
1. **Code check:** it must be prose, under `max_chars` (plus 20%), and name every person in the recorded state.
2. **Second opinion:** the judge model gets the recorded state, the folded turns (each trimmed, since the judge has a small context) and the recap, and must answer `faithful` with nothing `invented`.
   - Or, with `"verify": "fields"` (and `"verify_fields": ["score"]`), the **main model only reads the recap** and reports, per person, whether it says they are out and the value it states for each listed field; the **code compares** that with the recorded state *at the turn the recap ends at* and rejects any disagreement (a wrong score, an invented or missing exit). Measured offline: it caught every invented exit and every wrong score without false alarms. Prefer numbers: list fields (like colours) are also checked, but the record itself can be incomplete, which causes false rejections. No judge call is made in this mode. 

The compactor is shown, and the checks use, the record as it was at the turn the recap ends at (not the newer state), so a later score or a person who joined later never fails a correct recap. If the prompt is still over `at_tokens` even with the recap (the system prompt, state and the last `keep_turns` turns are already that big), the server waits 5 turns before folding again instead of paying for two model calls every turn; `wrap_up` is the way out.

A failed recap is rewritten once, with the objections. If it still fails, or the judge is down, the full chat is kept and the server waits 5 turns before trying again. A recap is dropped if the player edits any turn it covers or goes back before it. It is saved with the session. Every call is logged (`compactor`, `compaction_judge`).

**Escape hatch (`wrap_up`).** Compaction can only shrink so much. If the prompt is still over `wrap_up.at_tokens` (set it higher than `compaction.at_tokens` and below the model's window), the narrator gets a **WRAP UP** block with your `text` and closes the game on that turn, in the game's own voice. Every later turn gets a **GAME OVER** block with `after_text` (default: reply briefly, say the session has ended). With `over_reply` set, the server instead answers every later message with that fixed text and does not call a model, which can't be ignored. The server decides when; the model only writes the ending. With `on_exit`, the same final turn happens when the player (or everyone) has been recorded as out. The final turn is remembered with the session; regenerating it keeps it, and going back before it decides afresh.

Limits: the judge is small and sees trimmed turns, so a subtle slip can pass; the recorded state in the prompt still wins over the recap. Per-actor `history` is not recapped (it is capped by `history_limit`).

### How a turn works

1. The current state (and active session rules) is appended to your system prompt.
2. The model's narration streams straight through to Open WebUI.
3. A second, non-streaming call (temperature 0, with the model's thinking mode switched off, which on a thinking model is the difference between about 1 s and sometimes minutes) extracts a list of **ops** from the exchange.
4. The server validates and applies the ops, then enforces `limits` and `exit_when` in code.
5. On the first `setup_turns` turns, the judge runs the setup analysis (below).
6. The judge reviews session rules (if any are open).
7. The state is snapshotted and saved to disk.

Ops the extractor can emit: `set`, `inc`, `push`, `remove`, `add_actor`, `exit_actor`, and, with `id_domains`, `add` and `drop`. Every op is validated in code before it touches the state; invalid ones are skipped with a warning.

**What the model can and cannot change.** The model only *proposes*; the code decides:
- Server-owned and never writable by ops: `game.turn`, `game.exited_game`, `game.rules`, and every actor's `controlled_by` (who is a real person versus narrator-controlled). An op can only address a *field* of an actor, never replace a whole actor, and an `add_actor` can only create an NPC.
- Values must be plain, small JSON (at most 3 levels deep and 1000 characters), at most 50 ops are accepted per answer, and `game.current_actor` must be `null` or a real actor.
- `writable_fields` can restrict which actor fields ops may touch at all; `limits` clamp, `max_step` bounds the change per turn, and `exit_when` ends actors, all in code.
- Dice are rolled by the server; rule lifting needs non-empty evidence from the recorded story on consecutive turns, and setup analysis needs an exact quote from the player's own words.
- Every model prompt carries a notice that text inside `<player_message>`, `<narration>` and `<recorded>` markers is untrusted data, and that text has its angle brackets replaced so it can't close or forge a marker.

**What this does not guarantee.** The *content* of the state is still derived by models: the extractor decides what happened. A player can try to talk the narrator into giving them something, and a persuaded narrator is recorded faithfully. The code bounds the damage (limits, `max_step`, the allowlist, locked rules) but cannot tell a fair story from a manipulated one. Declare limits in `config.json` for anything that matters.

At a table the same turn runs once per **round**: the proxy first collects what each player says (a turn policy decides when a round starts), then narrates one round for all of them. See docs/OPERATIONS.md "Multiplayer".

### Robustness

- **Persistence:** every session is saved to `SAVE_DIR` (default `./saves`) with an atomic write and reloaded at startup.
- **Regenerate / edit:** snapshots are kept per user turn. If Open WebUI resends fewer or the same number of turns, the state rolls back to match.
- **Extraction retries:** up to 3 attempts, each told what was wrong with the last. If all fail, the exchange is kept as "unsynced" and folded into the next turn's extraction, so changes aren't lost. `/debug/state` shows the unsynced count, and waits (up to `DEBUG_WAIT_MS`, default 30000) for a session's background update to finish so it never shows the state from before the last reply; `pending: true` means it timed out.
- **Background requests:** Open WebUI's title, tag and follow-up generation (`### Task:` prompts) pass through without touching state.
- **Ordering:** requests for one session are serialized, so the next turn waits for the previous state update to finish.

## Game mode vs direct mode

If the system prompt opens with a condition, such as:

```
If the user's first message is "Imeng: Dungeon Adventure" follow these instructions.
```

then the **first user message of each chat decides the mode**, and the mode is stored with the session:

- **game:** the full proxy behaviour (state, rules, setup analysis, dice).
- **direct:** a plain pass-through to the model. No system prompt, no state, no judge. **Nothing is stored**: no save file on disk and no entries in the Redis log (including the invocation check itself).

How it decides:
1. If the opening of the prompt states no condition, the prompt always applies (game mode, no model call).
2. If the message is exactly the quoted trigger, game mode (no model call).
3. Otherwise the judge model checks whether the message invokes the instructions, so "hey can we play dungeon adventure?" starts the game while "Tell me a joke" does not. If the judge fails twice, the chat falls back to direct mode.

Regenerating or editing the first message re-runs the decision. Later messages never change the mode. Because direct chats are never saved, the mode is re-derived from the chat's first message if the proxy has no record of it (for example after a restart).

## Dice

With `"dice": true`, the server rolls a pool each turn (d20 x8, d12 x3, d10 x3, d8 x4, d6 x8, d4 x4, d100 x2) with `crypto.randomInt` and appends it to the narrator's prompt. The narrator is told to use them in order and show each roll, so an LLM can't quietly fudge them.

## Setup analysis

On each of the first 3 turns the judge model reads the opening messages and records:

- **Session rules** the messages establish (game mode, tone, constraints, who controls which characters). They go into `game.rules` and are shown to the narrator like any other rule.
- **The cast:** the person typing is the `user` actor, and any other character they mention is an **NPC** unless they explicitly say a real person controls it.

Example:

```
User:     Play Lighthouse RPG
Reply:    Lighthouse game started... who are you, and who is in your party?
User:     I am super hunky fighter guy. Tall, dark long hair. I got my wizard gf with me,
          short cropped hair and dark eyes.
```

Result: `actors.user` gets the fighter's description, and the girlfriend becomes an NPC with `controlled_by: "npc"` and `relationship: "partner"`.

Every item needs a quoted piece of evidence, items already recorded are not repeated, and rules are deduplicated. The analysis runs after the reply, so what it learns applies from the next turn on (the narrator can still read the messages themselves on the current one). Rules it adds are ordinary session rules, so the judge can later lift them.

## Other languages

Nothing in the engine is limited to English: text matching is Unicode-aware, and the pieces that are language-specific are settings. For a game in another language set `trigger_pattern` (how to recognise the trigger sentence at the top of your prompt), `placeholder_patterns`, and, if the small judge model does better with prompts in your language, `prompts`. `tests/fixtures/custom` is a complete Spanish example. The narrator's language is simply whatever your `SYSTEM_PROMPT.md` asks for.

