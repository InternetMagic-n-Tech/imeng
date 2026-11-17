# Spec: poker in the Dungeon Adventure imeng (future, not built; targets v1.4)

## Context
Dungeon (`imengs/dungeon-game`) is narrator-run with server dice/phases. The poker engine already has a server-kept Hold'em engine (`deal: "server"`, `betting: "server"`: `src/utils/poker-deal*.ts`, `poker-bet*.ts`, `poker-npc.ts`, `poker-seats.ts`, `poker-eval`). Goal: the party can sit down at a card table inside the delve (tavern room, gambler NPC, goblin dice-den) and play real Hold'em for gold. Decisions (user): server-kept, gold stakes in a tavern phase, seats = players + NPC companions + one encountered NPC.

## Status and versioning (decided)
- This is a **spec for later, not built now.** The 1.3 freeze was a guard against unrequested bumps; for this feature the user wants the next schema version: **v1.4** (new `migrations/1.3-to-1.4.md`, schema file, root `version` and games' `proxy_version` bump together, a test enforces equality). Do that only when the work starts.
- Not an embed of the poker imeng (one game per process): the engine code is already shared; the dungeon copies poker's config blocks. Phased: **Phase 1** single table (gold<->chips hook, copied poker phases, DB question). **Phase 2** multi-table (`game.table`) + per-table ban scope. Phase 1 needs no new engine keys.

## Principle
Reuse the poker engine unchanged where possible. It hard-codes `chips`, `bet`, `hole`, `status`, an `actors.table`, and phases `preflop/flop/turn/river/showdown`. So the dungeon gets a separate `chips` field and the **server converts gold <-> chips** at the table door; the narrator never touches gold or chips during a hand (rule 2).

## Game-folder changes (`imengs/dungeon-game`)
1. `config.json`
   - `deal: "server"`, `betting: "server"`, `private_hands: {field: "hole"}`, `tools.poker`, `sense` (optional), `shuffle: {required: "never"}`.
   - `actor_template` + `initial_state.actors.user`: add `chips: 0, bet: 0, hole: [], status: "in"`.
   - `initial_state.actors.table`: `{name: "Table", pot: 0, board: [], reserve: [], dealt: [], controlled_by: "npc"}`; `initial_state.game`: `hand, bet_level, small_blind, big_blind, max_raises, npc_aggression, leave_rule, buy_in`.
   - New phases (non-interrupt, `gated: true` so `magic` cannot cut in mid-hand): `card_table` (buy-in; `require` >= 2 seats with chips), `preflop`, `flop`, `turn`, `river`, `showdown`, `between`. Entry only from `explore` and `interact` (add `card_table` to their `next`). `between.next: ["preflop", "explore"]`; leaving goes to `explore`.
   - `actions` per street allow only poker fields; `writers` lock `hole, board, reserve, dealt, chips, bet, pot, status, game.phase`, blinds, `max_raises`, `npc_aggression`, and `gold` while in poker phases.
   - `limits`: `chips: {min: 0}`; `validate.mjs`: chips cannot go below 0, folded cannot bet, gold conservation (sum gold + chips unchanged across a poker session except via showdown transfers).
2. `hooks/phases.mjs` (new; computed ops the static route `ops` cannot do):
   - entering `card_table`: each living seat (hp > 0) moves `min(gold, game.buy_in)` gold into `chips`; dead and broke players get no chips (so `dealtIn` skips them).
   - leaving to `explore` (or a player leaving mid-hand): `gold += chips`, `chips = 0`, `hole = []`, `bet = 0`, table pot/board cleared. Chips are conserved by the engine, so gold is conserved overall; assert it in the hook and refuse the op otherwise.
3. `SYSTEM_PROMPT.md`: Poker section. The narrator describes the room, bluffs and banter; never states a card or amount not in `game.bet_log`/replies; never reveals hole cards (only at a showdown for hands still in); never changes gold/chips; poker is only entered when the story has a table. Entry rule: propose `imeng.phase: card_table` only on a challenge (gambler, bored guard, ghost) the party accepts; a hostile NPC at the table can turn to `combat` on a caught cheat (narrator proposes, normal gates apply).
4. NPC seats: companions (existing `controlled_by: "npc"` actors) and the encountered NPC get `chips` via the hook; play by `game.npc_aggression` (engine default rule). Dungeon NPC-fill rule (party up to 3) must not count `table`.
5. `VISION.md`, `HOW_TO_TEST.md` (new rows below), `README` mention, `package.json` `models` if retested.

## Engine changes (rule 1: defaults preserve behaviour, config key, docs/CONFIGURATION.md table)
Minimum needed, verify each before coding:
- **Process-wide DB requirement:** `deal`/`betting: "server"` makes the proxy refuse to start without `DATABASE_URL`. Dungeon would then need a database even for non-poker delves. Options: (a) accept, update dungeon HOW_TO_TEST and `docker-compose` profile; (b) engine change: server betting only requires DB once a poker phase is entered. Recommended: (b) if the hand-log requirement can degrade ("a failed write only warns"), else (a). **Needs a user decision.**
- `STREETS`, `dealtIn`, `tableId` use fixed names; fine because the dungeon uses the same names. No rename.
- `/deal` requires the current phase's `next` to include `preflop` (`dealCommand`): `card_table` and `between` satisfy it.
- Per-NPC style: `npc_aggression` is table-wide. Optional new key: read `actors.<id>.aggression` first (falls back to `game.npc_aggression`).
- `private_hands`/`/hand`: hole cards are shown only in a private chat; at a shared Open WebUI table that is the player's own chat. Document; no change.

## Several tables (decided)
- The delve may hold many tables (`actors.table_<id>`: `name, pot, board, reserve, dealt, stakes {small_blind, big_blind, buy_in}, host` NPC). A player sits at one at a time and may walk to another between hands; leaving cashes chips to gold (hook), joining buys in at that table's stakes.
- **Limit (stated, not hidden):** one hand is live per process, since `game.phase` is a single street. `game.table` names the active table; the others are dormant (their NPC seats and stakes persist, no hand runs). Parallel hands at two tables = a per-table phase, which is out of scope.
- **Engine change (new, default-preserving):** `betting`/`deal` read the table actor id from `game.table` (default `"table"`), instead of the fixed `actors.table` (`poker-deal-turn.ts` `tableId`, `poker-bet.ts`, `poker-seats.ts` `dealtIn`, which must also exclude every `table_*`). Add to docs/CONFIGURATION.md config table and `docs/IMENG-MAKING.md`; tests with the single-table poker fixture must still pass unchanged.
- Dungeon NPCs seated per table: the hook moves an NPC's `chips` with it when the table changes.

## Peeking and the magic item (decided: narrative)
- The item (e.g. a seer's eye, a warding charm) is story: the narrator may rule that the dealer/host is told of a peek, and the table reacts in the scene. No code check of the item and no ban from it.
- Code-side peek rules stay as `ban` already defines them (`/peek`, `reveal`, wrong guesses), but **scoped per table and per hand**: `ban` counters (`wrong_guess`, peek-once) key on `game.table` + `game.hand`, and a ban earned at a table applies to that table only. A player who leaves and sits at another table (or returns to the delve) starts clean; a ban never blocks non-poker phases. Needs a look at `src/utils/bans.ts` and `ban` handling to see what is process-wide today; if bans are per-session-player, add a `scope: "table"` option (default `"game"` preserves current behaviour).
- `private_hands`/`/hand` unchanged: shown only in the player's private chat.

## Out of scope (later)
Thief cheating (server dice check, caught -> fight), item/loot stakes, stud/Omaha variants, per-NPC tells via `sense`.

## Verification
- `npm run typecheck`, `npm run test:coverage` (85/85/85, 75 branches).
- New tests (fixture copy of the dungeon config in `tests/fixtures/`): buy-in and cash-out conserve gold; dead/broke players not dealt; `magic` cannot interrupt a gated street; gold locked from the narrator in poker phases; leaving mid-hand; failure paths (DB down pauses, hook refuses non-conserving ops).
- `npm run check:games`, doctor on `imengs/dungeon-game`.
- Live (port 3010, temp copy in /tmp, one narrator at a time): HOW_TO_TEST rows: Enter table (explore -> card_table -> preflop), Buy-in (gold -> chips), a full hand to showdown with chips settled, fold-out, `/hand` private only, NPC companion plays, leave (chips -> gold), `magic` blocked mid-hand, dead player not seated, all-in/side pot. Record models; stop servers, unload models.
