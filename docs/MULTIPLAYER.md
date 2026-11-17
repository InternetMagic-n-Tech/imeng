# MULTIPLAYER.md

Several people, one game, through Open WebUI's own group chat. Also here: MLflow tracing, lighter session saves, and the id/reference settings. Everything is **off unless you turn it on**; a game that sets none of it behaves as before. `imengs/dungeon-game` is the worked example (and its `HOW_TO_TEST.md` is the live test).

## 1. How it works

A **table** is a chat shared with Open WebUI's **Allow replies** (or a channel). Open WebUI already does the group-chat part: it decides who may open and write in the chat, shows everyone each message and reply live, and keeps the history. The proxy adds the game on top. From Open WebUI's source (0.13.3): a collaborator's message reaches the proxy as that person's own request, after Open WebUI has checked their write access, carrying their `X-OpenWebUI-User-Id` and the shared chat's `X-OpenWebUI-Chat-Id` (a channel's chat id is `channel:<id>`). So one table is one chat id, one session, and each speaker is known by their user id.

- The first person to speak is `actors.user`; the others are `actors.p_<name>` (`controlled_by: "other_player"`, never an NPC).
- A chat that was solo becomes a table the moment a **second** person speaks in it. The story so far becomes the room's transcript.
- The narrator is fed the room's own transcript (one user message per round, one reply), not the chat, so status lines and beats never clutter its context.
- Room state, seats and the transcript are saved with the session and survive a restart. Regenerate/edit in Open WebUI have no meaning at a table.

## 2. Setup

1. Open WebUI: `ENABLE_FORWARD_USER_INFO_HEADERS=true`, restart. (Open WebUI URL-encodes the name header; the proxy decodes it. For signed headers instead, Open WebUI also has `FORWARD_USER_INFO_HEADER_JWT`: not used yet, a good fit for the security audit.)
2. The game model must be visible to the other accounts: **Admin Panel > Settings > Models**, **Visibility** (or a group).
3. In `config.json`: `"multiplayer": { "enabled": true }`.
4. The owner starts the game in a new chat, then **Share > Sharing mode: Allow replies**, with the friends' accounts or a group as the audience (Open WebUI's access control is the gate; there are no invite codes). Friends open the link and write in the chat.
5. docker-compose: the proxy needs `REDIS_URL` (you have it for the log) for seats to be shared across restarts or containers. MLflow, if used: section 8.

To see what Open WebUI really sends, run once with `MULTIPLAYER_DEBUG=1` and read `SAVE_DIR/multiplayer-debug.jsonl` (header names and values with secrets hidden, message sizes, and which table the request landed at).

## 3. Turn policies (`turns`)

With fewer than `min_players` (default 2) at the table, every message is simply a round, whatever the policy.

| `turns` | A round starts when... | Messages that are not "the move" |
|---|---|---|
| `ready` (default) | everyone the game waits for has said "ready" (`confirm_pattern`). Until then the proxy only collects what players say (planning, "telepathy": no model sees it yet) | none: everybody's words go into the one round; a new message after "ready" takes the ready back (`reset_on_talk`) |
| `free` | every message (real time). Also what `gate: false` meant | n/a |
| `token` | the player whose actor is named by `token_field` (default `game.current_actor`: the magic wand) writes. If nobody holds it (or an NPC does), anyone may | `off_turn`: `note` (default) tells them whose turn it is; `queue` keeps their line and gives it to the narrator in the holder's round |
| `judged` | the judge model reads each message against `turn_rule` and the last narration: `act` starts a round, `hold` (not their moment) and `chat` (table talk) do not. It also says who the story is now waiting on | `hold` is noted or queued per `off_turn`; `chat` is just "Noted." |

`turn_rule` is plain words for the judge, e.g. a radio simulation: `"Only the crane operator reacts to radio calls; the foreman may speak at any time."`. With `judge: false`, `judged` behaves like `free`.

**Order of lines in a round** (`order`): `fifo` (arrival, default), `filo` (latest first), `join` (the order people joined; a player's own lines keep their order), `random`, or `{ "by": "initiative", "desc": true }` (an actor field; people without it go last, ties by join order).

## 4. While the table waits (`tension`)

When a message does not start a round, the table sees a line in the shared chat. This is a **configuration option**:

| `tension.mode` | The table sees | Cost |
|---|---|---|
| `status` (default) | a terse line: `Ready: Bea. Waiting for: Bo.` | none |
| `beats` | one short in-story line from the narrator that keeps the waiting player's declared action in suspension and moves it one frame: "Wolverine coils like a spring about to leap..." then "Wolverine sails through the air..." then "...towards the villain". It never resolves the action and decides nothing for anyone. Others' messages are caught in the same line if they fit | one short narrator call (the GPU) per message |

`max_words` (default 25) caps a beat; `cooldown_seconds` (default 0) spaces beats out, with the terse line in between; if the narrator fails or says nothing the terse line is used. Beats are visible to everybody but are not part of the story the next round is narrated from; the round is what resolves the action.

## 5. Private chats (AD&D style)

Anything typed in the shared chat is seen by everybody. So the **private channel is each player's own chat** with the game:

- Speaking at a table gives a person a **seat** (remembered by their user id; Redis hash `game:seats`, `SAVE_DIR/seats.json`). A **new** chat of a seated person with the game is their private channel. A chat that already had its own game stays solo. A seat that is not used for `seat_days` (default 14) lapses; `leave the table` (`leave_pattern`) gives it up.
- `private.forget: true` keeps a private note out of the table transcript once its round is narrated (default false). See IMENG-MAKING.md, "Secrets and the message history".
- A private answer may tell a player what is their own (their cards, their notes) but never another player's secrets or anything the table has not seen.
- A private message never starts a round and the table never sees it. A note is kept and goes to the narrator **with the next round, marked** `PRIVATE, never reveal to the other players:` (`narrator_sees: false` keeps notes out of the model).
- **`private.reply` is a configuration option:** `ack` (default: a fixed "Noted: the DM will weigh it in the next round. Only you can see this."), `narrator` (a short private narrator answer of at most `max_words`, one extra narrator call; if it fails you get the `ack` line) or `none`. `private: false` turns private chats off.
- From a private chat a player can also step away, leave, or leave a standing instruction (section 6). Say the same thing at the table and it is public (the instruction is then not accepted unless `standing` is `any`).

## 6. Stepping away, the clock, giving up

**Stepping away.** With the judge on and two or more at the table, "I need the bathroom", "my mom's calling", "phone call, hold up" is read as `pause` (the judge is told never to write the reason; **no reason is stored**). The game stops waiting for them (a round that only they were holding starts), the narrator is told `NOTE: Away right now (their characters sit out): Bo.`, and the game's prompt decides what that means. It can last minutes or years. They are back **when they speak again** (opt-in); that round starts with `NOTE: Bo is back after 3 days away; in the story 5 minutes passed meanwhile.`

**The clock.** `clock: { "field": "game.minutes", "unit": "minute" }` names the number the recorder keeps as in-game time (`second`, `minute`, `hour`, `day`, `week`, or `count` for a plain counter like `game.round`). The proxy reads it when someone steps away and when a round opens, so story time is measured from the state, never from real time.

**Standing instructions.** In a private chat (or anywhere with `standing: "any"`): "if I don't answer in 5 real days, assume I figure it out", "if I'm gone 3 in-game days, my character takes the safe option", "if I don't reply in 5 days, have the party pursue my objective". The judge extracts `{after_real, after_game, action}`. When the table is **waiting on that player** (ready: not yet ready; token: they hold it; judged: in `awaiting`) and the real time since the round opened, or the story clock, has passed, their line becomes `(not heard from in 5 days; figures it out)` and the round goes on. A player with no instruction gets the game's `default_after` (`{ "real": "3d", "game": 2 }`) and `default_action` (default `"says nothing"`); with no `default_after` the table waits forever. The proxy cannot send messages or run timers: **timeouts are checked when someone sends the next message**.

## 7. `multiplayer` keys

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | everything below is ignored unless `true` |
| `turns` | `ready` | `ready`, `free`, `token`, `judged` (section 3) |
| `token_field` | `game.current_actor` | policy `token`: the game field naming the holder |
| `off_turn` | `note` | `note` or `queue` |
| `turn_rule` | | words for the judge |
| `order` | `fifo` | `fifo`, `filo`, `join`, `random`, `{by, desc}` |
| `clock` | none | `{ field: "game.<f>", unit }` |
| `tension` | `{ mode: "status", max_words: 25, cooldown_seconds: 0 }` | section 4 |
| `private` | `{ reply: "ack", narrator_sees: true, max_words: 60, unseated: "ignore" }` | section 5; `false` turns private chats off. `unseated`: a `<private>`-only message in the shared chat from someone not at the table is `ignore`d (answered with `private_only_reply`, nothing kept) or `seat`s them and files the note |
| `seat_days` | `14` | how long a seat keeps new chats private |
| `leave_pattern` | `^\s*(leave\|quit)( the)? (table\|game)[\s.!]*$` (i) | a whole message that leaves the table |
| `standing` | `private` | where standing instructions are accepted: `private` or `any` |
| `default_after` / `default_action` | none / `says nothing` | what happens to someone the table waited on too long who left nothing |
| `idle_vote` | off | `{limit, min_votes}`: after the idle limit agreed at registration, the others can `/idle` to move a blocker on (see IMENG-MAKING.md) |
| `judge` | `true` | the judge model reads messages at a table of 2+ (turn rule, pause, standing) |
| `gate` | | old name: `false` means `turns: "free"` |
| `confirm_pattern` | `^(ready\|confirm\|confirmed\|done\|go)[\s.!]*$` (i) | a **whole message** matching it means ready; a leading `@mention` (also `@<model_id>`) is ignored |
| `reset_on_talk` | `true` | policy ready |
| `min_players` | `2` | below it every message is a round |
| `idle_minutes` | `0` | above 0, quiet players are not waited for |
| `max_players` | `8` | 2 to 50 |

Cost: with `judge` on, each message at a table of two or more (and each private message) is one small judge call. The judge only classifies; the code applies the result, and no answer means the plain policy rules.

## 8. Also: tracing, lighter saves, ids and references

**MLflow tracing**, off unless both are set (the OTLP endpoint needs the experiment **id**): `MLFLOW_TRACKING_URI` (e.g. `http://mlflow:5000`; the proxy posts to `<uri>/v1/traces`) and `MLFLOW_EXPERIMENT_ID`. Optional: `MLFLOW_RUN_ID`, `MLFLOW_TRACKING_TOKEN` (Bearer), `MLFLOW_CAPTURE` (`meta` default: timings, models, sizes, counts; `full`: also prompts, responses, the player's message and the narration), `MLFLOW_TIMEOUT_MS`, `MLFLOW_DEBUG`. One trace per request in a game chat (direct chats and Open WebUI's title/tag tasks are not sent): a root span `turn N` (`session.id`, `user.id`) and a span per model call, plus a `state.apply` span. No new npm dependencies. MLflow must accept OTLP traces (3.x, SQL backend; a file store answers 501, reported once per 30 s without affecting the game).

**Lighter session saves**: `SAVE_COALESCE_MS=<n>` (default `0` = write at once). Above 0, a save is written in the background at most once per `n` ms per session (newest wins), an unchanged state is not rewritten, a slow write (over 250 ms) is reported with its size, and pending saves are written on a clean exit. A hard kill can lose the last `n` ms. Try `250`. Session state was never in Redis; Redis holds the log and the seats.

**Ids, references, field access** (optional `config.json` keys, all in `imeng.schema.json`): `actor_ref_fields` and `refs` make fields hold only ids (a name the model writes is matched to an id by the judge from a numbered list, never by code; the field is cleared when the entry goes); `id_domains` says where things with ids live and how ids are made (`mint`: `uuid` 4/5/7, `random`, `number`, `counter`, `timestamp`, `hash`; `when`: `creation`, `collision`, `change`) with the ops `add` and `drop`; `field_access` makes a field `read-only` or `write-only`; addresses in values (`actors.npc_0.score`) are replaced by the live value, except server-owned and write-only fields, whole entries, and anything typed in the player's message or the narration.


## 9. Known gaps

- Not verified in Open WebUI: whether each message of a shared chat carries its sender's name in the payload (the design does not need it), and how two people sending at the same instant are queued by Open WebUI itself. The proxy runs one request per table at a time.
- **Model readiness is not built.** A possible design: probe Ollama's `/api/ps` and continue when the expected model is loaded (or the other one unloads), with a clear log line after a timeout.
- A plain private note (not a recorded fact, section 11) goes to the narrator, which could leak it in a reply the whole table reads. The code never shows it to the table; the prompt forbids it; `private.narrator_sees: false` keeps it out of the model. Recorded facts are guarded by section 11.
- Texts the proxy writes itself ("Waiting for...") are English only. Without Open WebUI's user id nobody can be told apart, so such requests stay ordinary solo chats.
- Security audit pending: the proxy trusts the user-id header Open WebUI forwards (the signed `FORWARD_USER_INFO_HEADER_JWT` mode would let the proxy verify it). Keep the proxy off the tunnel (or set `PROXY_API_KEY`).
- Non-actor id domains get no `actor_template` defaults and no `allowed_values`.

## 11. Secrets and partial knowledge (`knowledge`)

Off unless `knowledge.enabled` is true; needs `multiplayer` (the private chat is where facts get in). Optional keys only, `schema_version` stays 1. The rule: **a model never receives a fact it may not use this round.** "Told not to reveal" is not secrecy, so the facts live in a server-owned store (`session.knowledge`, saved with the table) that is outside every state snapshot and is never given to the extractor, the compactor or a recap.

**A fact** has `about` (an actor id), `knownBy` (actor ids or names), `access`, `watch` words, `discover` triggers and `createdBy`.

| `access` | Who gets the text |
|---|---|
| `never` | no model, until it is revealed (a hidden tattoo) |
| `roleplaying` | the narrator, only on a round where a knower speaks or is addressed (the brother who saw them enter the shop) |
| `dm` | nobody but the owner, who can list it in their private chat |

**Getting a fact in.** In a private chat, in plain words: "my brother saw me go into the tattoo shop". The judge structures it (about, knowers, access, give-away words, how it could come out); code checks it (the sender must be the subject or a knower; ids must exist). With `confirm_facts: "player"` (default) the player sees the reading and must reply `yes` (`no` drops it). Nothing reaches the narrator before that, and the message is **never** added as a PRIVATE note. If the judge cannot be read the message is **not passed on** (the player is told) rather than sent to the narrator unchecked. Anything the judge calls an ordinary note goes to the narrator as before. A secret typed in the shared chat is public: only the private chat is protected. `notes` lists your own facts; `forget <id>` removes one of yours (`notes_view`).

**Discovery.** After every round the judge reads the round's lines and the narration against each hidden fact's triggers (it sees the trigger wording, never the fact's text). Code applies an answer only when its quote is verbatim in the round. An `action` trigger (a sleeve rolled up) reveals at once by default; a `statement` trigger (the brother says it) waits for **the person it is about to confirm in their own next lines** within `candidate_turns` rounds, and code checks that the person wrote the confirming quote. A fact about an NPC cannot be confirmed by anyone and reveals at once. `triggers.action`/`triggers.statement` set the defaults (`none` or `owner`); a trigger's own `confirm` wins. A revealed fact reaches the narrator once under `JUST REVEALED`, then under `KNOWN TO THE TABLE`. A replayed (regenerated) turn hides again what came out on it.

**The leak.** The narrator can still state a fact it holds in a reply the whole table reads. `leak`: `retry` (default) holds a reply that follows a round where the narrator held a fact (it is not streamed that round), scans it for the fact's `watch` words, asks for one rewrite, then redacts the giving-away sentences; `redact` redacts at once; `audit` delivers and logs; `off` does nothing. A fact with a statement trigger may be spoken by its knower: quoted speech is not scanned for it. The scan is a word match: it misses a paraphrase. A `never` fact cannot leak because no model has it; the narrator may still invent a detail that contradicts it, which the `JUST REVEALED` notice tells it to correct.

**Passing a fact on (`transfer`, default `off`).** `tell`: in their private chat a player says their character secretly passes something to named characters ("I whisper my tattoo to Bo", "I sign to the brother that I leave before dawn"). The judge reads it (recipients, medium: `whisper | gesture | glance | sign | note | other`, and which of the player's own facts, if any); code checks that each recipient is a real actor other than the sender, that the fact is the sender's and not a `dm` note, and the player confirms as for any fact. Only the recipients then know it: the fact's knowers grow, a `never` fact becomes `roleplaying`, the narrator holds it on rounds where a recipient speaks or is addressed, and the recipient sees it in their own `notes`. Nobody else learns it. If the judge cannot be read, or names nobody real, nothing is passed on and nothing reaches the narrator. `covert`: `tell`, and after each round the narrator-class model (one extra call per round, only with two or more NPCs) lists what NPCs secretly pass to each other; code keeps only NPC-to-NPC acts, at most `covert_max` (2) per round, each becomes a fact known to those NPCs only (so two NPCs can scheme against a player or each other; the narrator gets it when one of them speaks). The recipient and any NPC fact stay between the people named: what the rest of the table could perceive (a knowing look) is the job of the judges not yet built. Transfers are not undone when a turn is replayed.

**Audit.** `session.knowledge.audit` (proposed, added, viewed, removed, transfer, covert, candidate, revealed, expired, leak, leak-retried, leak-redacted, rollback) keeps ids and turns, never text. `npm run sessions` exports the whole store, secrets included: treat exports like Redis logs. The judge model reads secrets when it structures them; the narrator, extractor, compactor and recap writer do not.

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | everything below is ignored unless `true` |
| `confirm_facts` | `player` | `player` or `off` (save at once) |
| `match` | `name` | `name` (a knower's name or actor id is in the round) or `judge` (the judge reads the round; it never sees the text) |
| `triggers` | `{action:"none", statement:"owner", candidate_turns:3}` | defaults for confirmation |
| `leak` | `retry` | `retry`, `redact`, `audit`, `off` |
| `transfer` / `covert_max` | `off` / `2` | `off`, `tell`, `covert`; most covert acts per round |
| `notes_view` | `true` | players list and forget their own facts |
| `max_facts` / `max_chars` / `audit_keep` | `60` / `1500` / `200` | store size, characters of facts per narrator prompt, audit entries |
| `confirm_pattern`, `cancel_pattern`, `notes_pattern`, `forget_pattern` | yes / no / notes / forget `<id>` | whole-message patterns (case-insensitive) |
| `seed` | none | facts the game itself holds (an NPC's agenda): `{id, text, about, known_by, access, watch, discover}` |

Costs: one small judge call per private message and per round with a hidden fact that has a trigger (`match: "judge"` adds one). Texts the proxy writes to the player are English only. Not verified live: only fake-model tests (`tests/knowledge.test.ts`, `knowledge-app.test.ts`) have run.

## 10. Tests

Every model, judge, Redis and MLflow call is faked (the existing `fake-ollama`, a stubbed `fetch`, a fake Redis), so nothing loads the GPU or CPU. New: `tests/multiplayer.test.ts` (policies, order, away, standing, clock, holds, notes), `multiplayer-app.test.ts` (shared chat to table, rounds, private chats, timeouts over the real app), `multiplayer-tension-app.test.ts` (beats and private narrator replies), `seats.test.ts`, `room-judge.test.ts`, `durations.test.ts`, `game-making.test.ts` (the guide's stamp), plus the id/field-access/MLflow/save tests. Run one: `npm test -- tests/multiplayer-app.test.ts`. The run is in `logs/test-run.log`.

### `<private>` and whisper notices at a table
A private-only `<private>...</private>` message in the shared chat is handled like a message in the sender's private chat (section 4): a note for the narrator, or a fact, whisper or command when `knowledge` is on; it starts no round. Open WebUI shows the shared chat to everyone in it, so the tag hides text from the characters and the narrator's output, not from the other people at the table; use a private chat for a secret from them. With `knowledge.notice` (default `seen`) the narrator is told on the next round that the table saw a whisper, look or note pass between characters, never its content. See IMENG-MAKING.md, "Private text".

### Owner (`owner`)

The first real person to speak owns the table. Commands `/owner`, `/successor`, `/claim`, `/telemetry` work at the table or from a private chat. Ownership never changes except through `/claim` after the owner has been away (see IMENG-MAKING.md, "Owner and telemetry"). A frozen owner is still the owner.

### Linking accounts (`link`) and freezing (`freeze`)
`/link` makes one code (8 characters without O, I, L, 0, 1, or memorable words, set in config.json `link`). Send `/link` in one app and `/link CODE` in the other within the ttl; the two accounts become one player and the seat moves with them. Codes are single use, expire, lock a user after `max_fails` wrong tries, and live only in memory: a restart loses them. Discord gets the code by direct message; Open WebUI shows it in the chat reply, which is removed from the conversation the engine keeps, so reopening the chat forgets it. A secret stays where it was said: whispers are never copied between apps.

`/freeze` (yourself; with `freeze.others:"anyone"` also `/freeze Name`) and `/unfreeze`. The table does not wait for a frozen player and their messages are not heard. `mode:"npc"` has the narrator play them meanwhile (`controlled_by: "npc"`). On `/unfreeze` with `catch_up:"public"` the person reads the public narration since the freeze; whispers and private notes are never included. Commands are not rounds and never shift rollback. Texts can be changed in `link.texts` and `freeze.texts`.

## Secret goals at a table (`goals`)

A person writes a goal in their private chat with the game: `/goal <text> [because <reason>]` or a plain note the judge reads as one (with an optional reason). A spoken message at the table may carry a `<private>` part: the public words are the goal and the private part is its reason, captured silently while the round goes on; the private part is not queued as a narrator note. Never at the table itself (the shared chat is read by everyone; `/goal` there is refused and stored nowhere). The goal text lives in a server store outside the snapshots; the narrator is told only the goals `goals.host` allows (blind: none; own: the NPCs'; all: everyone's). `/goals` in the private chat lists your own and, after the game, the standings. See IMENG-MAKING.md, "Secret goals".


**The dead (`silenced_when`, `silenced_reply`):** `silenced_when` is a condition on a player's own character (for example `{"field":"hp","lte":0}`). A person whose character meets it is ignored in the shared chat: no narrator call, no change to the game, and they get `silenced_reply` (default "The living do not hear you."). Their private channel still works. `max_players` caps the table (the Dungeon uses 6).
