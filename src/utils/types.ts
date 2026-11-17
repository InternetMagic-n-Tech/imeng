import type { Condition } from "./conditions.js";
export type Mode = "game" | "direct";
export type Controller = "user" | "npc" | "other_player";

/** An OpenAI-style chat message (content may be a string or an array of parts). */
export interface ChatMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface Actor {
  name?: string;
  controlled_by?: Controller | string;
  description?: string;
  relationship?: string;
  statuses?: unknown[];
  history?: unknown[];
  [field: string]: unknown;
}

export interface Rule {
  text: string;
  locked: boolean;
  lift_hint: string;
  active: boolean;
  lift_votes: number;
  source?: string;
  turn_added?: number;
  announced?: boolean;
  lifted_turn?: number;
  lifted_reason?: string;
  last_evidence?: string;
  last_reason?: string;
}

export interface ExitedActor {
  id: string;
  reason: string;
}

/** A timed effect on someone ("wears the hat backward"): code expires it at `until` (a game turn); the judge may release it earlier. */
export interface Effect { id: string; who: string; text: string; until: number }

export interface GameInfo {
  turn: number;
  current_actor: string | null;
  exited_game: ExitedActor[];
  events: string[];
  rules: Record<string, Rule>;
  [field: string]: unknown;
}

export interface GameState {
  game: GameInfo;
  actors: Record<string, Actor>;
}

/** One player message and the narration that answered it. */
export interface Exchange {
  user: string;
  narration: string;
}

export interface Ownership {
  created: number;
  successors: { userId: string; name: string }[];
  /** Real people who spoke here: the only ones who can be named successors. */
  people: Record<string, { name: string; seen: number; /** Spoken turns here. */ msgs?: number; /** 0 to 1, how the person tends to behave (from the tone judge); unknown when absent. */ tone?: number; /** Asked to be considered as a successor: pending until they answer. */ consent?: "pending" | "yes" | "no"; /** Their last few lines, held only until the judge reads them. */ recent?: string[]; /** The spoken-turn count when they were last rated. */ toneAt?: number }>;
  /** When the owner was last asked whether to keep the room; asked again every owner.ask_after. */
  askedAt?: number;
  /** The question is out and not yet answered. */
  asking?: boolean;
  telemetry: "on" | "off";
  /** What the players were last told about telemetry. */
  disclosed?: "on" | "off";
  reason?: string;
  /** Answers to the claim questions: hashed or plain (config.json owner.answers). */
  challenge: { id: string; a: string }[];
  claims: Record<string, { step: number; fails: number }>;
  closed?: boolean;
  /** Lines for the table, told once with the next reply. */
  notices: string[];
}

export interface Session {
  /** Messages trying to sway the table about hidden cards, per player and hand. */
  guesses?: Record<string, { hand: number; n: number }>;
  /** People watching without a seat who asked to see the hands, and the hand they asked in. */
  viewers?: Record<string, number>;
  /** Who peeked at whose cards in which hand (one peek per hand). */
  peeks?: Record<string, { hand: number; target: string }>;
  /** Credit: players who have already been given a re-entry code for this bust. */
  credit?: { told: Record<string, boolean>; /** The owner's messages counted, for loan confirmation. */ ownerMsgs?: number; marks?: { n: number; p: number; s: number; w: number; h: string }[]; pending?: { target: string; name: string; amount: number; mark: { n: number; p: number; s: number; w: number; h: string }; until: number; tries: number } };
  /** Typed announcements (owner changes, peeks...), kept so an adapter can deliver them its own way. */
  /** Producer signal ids already applied (a signal arriving by two adapters runs once). */
  signals?: string[];
  /** Id of this session's rows in the `hand_log` table (utils/hand-log.ts), assigned on first use. */
  logId?: string;
  /** What the house may read about the cards (imeng `audit`): short lines, newest last. */
  cardLog?: string[];
  announcements?: { id: string; kind: string; from?: string; to?: string; text: string; at: number; delivered?: boolean }[];
  /** snapshots[i] = state after i user turns, so regenerate/edit can roll back. */
  snapshots: GameState[];
  /** Exchanges whose state extraction failed; retried with the next turn. */
  unsynced: Exchange[];
  mode?: Mode;
  /** Version of the game (its package.json) when this session began; saved so a later major change can be flagged. */
  gameVersion?: string | null;
  /** Server-written recap standing in for the first `upto` turns of the chat (see compaction). */
  summary?: { upto: number; sig: string; text: string };
  /** Do not try to compact again before this turn (after a failed attempt). */
  compactHold?: number;
  /** The turn on which the narrator was told to close the game (the context was nearly full). */
  wrapUp?: number;
  /** Closing instructions from a turn event with `end` (used instead of wrap_up.text on the final turn). */
  wrapText?: string;
  /** What was said and narrated since the last game turn (public and private), for the judged advance. Newest last. */
  turnLog?: { round: number; text: string }[];
  /** Text of turn events that fired after round `round`: shown to the narrator once, on the next round. */
  pendingEvents?: { round: number; text: string }[];
  /** The producer's nudges the narrator has not been shown yet (utils/nudge.ts). */
  nudges?: string[];
  /** Who has been sent the game's terms, and until when (terms.remember_days): only used when there is no database (utils/terms.ts). */
  terms?: Record<string, number>;
  /** Rule violations the judge found in the narration of turn `turn`; shown to the narrator once, on the next turn. */
  violations?: { turn: number; items: { id: string; quote: string; reason: string }[] };
  /** Seeds, reference images and a pending picture offer (utils/images.ts). */
  visuals?: Visuals;
  /** Frozen characters by actor id (utils/freeze.ts). */
  frozen?: Record<string, Frozen>;
  /** Lines about people who came back since the last round: told to the narrator once. */
  freezeNotes?: string[];
  /** Several real people playing one game (see utils/multiplayer.ts). */
  room?: Room;
  /** Fingerprints of the completed turns, one per turn (utils/sync.ts). */
  prints?: TurnPrint[];
  /** Bounded log of how the record was kept in step with the conversation. */
  audit?: AuditEntry[];
  /** The record was rebuilt or partly replayed, so some details may be approximate. */
  approximate?: boolean;
  /** Replays that failed in a row (the extractor was not answering). */
  syncFailures?: number;
  /** The record could not be rebuilt: the player was asked to try again or start a new chat. */
  abandoned?: { at: number; reason: string };
  /** Redis store: the version this copy was read or written at (see utils/store.ts). */
  version?: number;
  /** Per-session state kept by tools (utils/tools.ts), saved with the session. */
  tools?: Record<string, unknown>;
  /** The first person who spoke in this chat (a second person speaking here makes it a table). */
  owner?: { userId: string; name: string };
  /** Who owns the chat, who may inherit it, and what the players were told about telemetry (utils/owner.ts). */
  own?: Ownership;
  /** A private chat with the game: the session key of the table it is a side channel of. */
  privateFor?: string;
  /** Facts only some people know (utils/knowledge.ts). Server-owned: never part of a snapshot, never read by the extractor. */
  knowledge?: Knowledge;
  /** Names reserved by the naming call for characters the narrator is about to introduce (fictional names; server-owned). */
  namePool?: string[];
  /** Temporary bans: user id -> when it ends (milliseconds). */
  bans?: Record<string, number>;
  /** The deck as it was at the start of a turn, so a regenerate or an edit rolls the cards back with the record (server-owned, last 50 turns). */
  deckAt?: Record<number, { cards: { rank: string; suit: string }[]; hands?: Record<string, { rank: string; suit: string }[]> } | null>;
  /** The shared deck for the deck phase (server-owned, never in a snapshot): cards top first. */
  deck?: { cards: { rank: string; suit: string }[]; hands?: Record<string, { rank: string; suit: string }[]> };
  /** The dating show's private facts about contestants and who has learned them (server-owned, never in a snapshot). */
  dating?: { facts: { id: string; actor: string; kind: string; text: string; to: string[] | "all" }[]; seq: number };
  /** Secret goals (utils/goals.ts). */
  goals?: GoalStore;
  /** Promise chain that serializes requests for this session. */
  tail: Promise<unknown>;
}

/** A standing instruction a player left (in the hidden channel): what their character does if the game waits on them too long. */
export interface Standing {
  afterRealMs?: number;
  /** In the unit of the game's clock. */
  afterGame?: number;
  action: string;
  setAt: number;
}

export type FactAccess = "never" | "roleplaying" | "dm";
/** How a hidden fact can come out: something done or seen, or something said (and, by default, confirmed by the person it is about). */
export interface FactTrigger { kind: "action" | "statement"; when: string; by?: string; confirm?: "owner" | "none" }
export interface Fact {
  id: string;
  text: string;
  /** Actor id of who it is about. */
  about: string;
  /** Actor ids or names of everyone in the story who knows it. */
  knownBy: string[];
  access: FactAccess;
  /** Words that would give it away in a narration (leak scan). */
  watch: string[];
  discover: FactTrigger[];
  /** The user id that recorded it, or "game" for a seed from config.json. */
  createdBy: string;
  createdTurn: number;
  /** Set when it came out; `announced` once the narrator has been told. */
  revealed?: { turn: number; announced: boolean };
  /** A statement was seen and waits for the person it is about to confirm. */
  candidate?: { trigger: number; turn: number; expires: number };
}
/** One change to the knowledge store, kept without the fact's text. */
export interface KnowledgeAudit { at: number; turn: number; kind: string; fact: string; detail?: string }
/** How something is passed on in secret. */
export type Medium = "whisper" | "gesture" | "glance" | "sign" | "note" | "other";
export const MEDIA: readonly Medium[] = ["whisper", "gesture", "glance", "sign", "note", "other"];
/** A player passing an existing fact on to others (the recipients then know it; the table does not). */
export interface Transfer { fact: string; to: string[]; medium: Medium }
/** What waits for a player's yes in their private chat: a new fact, or a transfer of one they hold. */
export interface Pending { fact?: Fact; transfer?: Transfer }
export interface Knowledge { facts: Fact[]; pending: Record<string, Pending>; audit: KnowledgeAudit[]; seq: number }

/** What the record remembers of a completed turn, to tell later whether the conversation still matches (utils/sync.ts). */
export interface TurnPrint { u: string; a: string }

/** One decision of the sync layer, kept with the session (no message text). */
export interface AuditEntry { at: number; turn: number; kind: "turn" | "adopt" | "back" | "detected" | "replay" | "replay-failed" | "rebuild" | "refused" | "recovered"; detail: string; tip: string }

/** A real person in a shared game. */
export interface RoomPlayer {
  userId: string;
  /** The checked seat picture (a stored name and what it shows), shown to the table at the start and purged after `seating.photo.keep_hours`. */
  photo?: { name: string; kind: "face" | "body"; at?: number };
  name: string;
  /** The actor that person plays (the first player is actors.user). */
  actor: string;
  lastSeen: number;
  /** Frozen with /freeze: the table does not wait for them and their messages are not heard until /unfreeze. */
  frozen?: boolean;
  /** Stepped away (no reason is kept). The game does not wait for them; they are back when they speak again. */
  away?: { realAt: number; gameAt?: number };
  standing?: Standing;
}

/** One thing a player said while the round was open. */
export interface TalkLine { userId: string; text: string; auto?: boolean }

/** The shared side of a multiplayer game: who is at the table, what has been said since the last round, who has confirmed. */
export interface Room {
  /** Secret dealings the table saw happen (not what was passed): shown to the narrator once, on the next round. */
  whispers?: string[];
  /** NPCs who witnessed a secret dealing (and whether they caught it): the narrator's eyes only, shown once on the next round. */
  overheard?: string[];
  /** What passed in secret since the last debrief (what the table noticed, and what each NPC witness gathered), waiting for the producer's beat (knowledge.debrief). */
  debrief?: { seen: string[]; npc: string[] };
  players: Record<string, RoomPlayer>;
  /** User ids in the order they joined. */
  order: string[];
  /** What was said since the last round (the players' plans, in arrival order). */
  talk: TalkLine[];
  /** User ids that confirmed since the last round. */
  confirmed: string[];
  /** Policy "judged": the user ids the story is waiting on, as the judge last read it. */
  awaiting?: string[];
  /** When the current round opened (the last round was narrated, or the room began), and the game clock then. */
  openedAt?: number;
  openedGame?: number;
  /** Private notes players passed to the narrator from their own chats; they go in with the next round. */
  notes: { userId: string; text: string }[];
  /** The last tension beat shown at the table (for continuity); cleared when a round is narrated. */
  beat?: { text: string; at: number };
  /** The room's transcript: one user message per round (every player's lines) and the narration that answered it. */
  history: ChatMessage[];
  rounds: number;
  /** Players who voted /idle on the current blockers; cleared when a round is narrated or the vote passes. */
  idleVotes?: string[];
  /** seating: a profile waiting for /seat yes, and people confirmed while a hand was on (seated between hands). */
  seatPending?: Record<string, SeatProfile>;
  seatQueue?: { userId: string; name: string; profile: SeatProfile; at: number; approved?: boolean }[];
}

export interface SeatProfile { age: number; gender: string; sexuality: string; /** The accepted seat picture (stored name, what it shows, when). */ photo?: { name: string; kind: "face" | "body"; at: number } }

/** A state-change operation produced by the extractor. */
export interface Op {
  op: string;
  /** add / drop: the id domain the entry belongs to. */
  domain?: string;
  path?: string;
  value?: unknown;
  id?: string;
  reason?: string;
  /** effect: who it is on (an actor id), what it is, and for how many game turns. */
  who?: string;
  text?: string;
  turns?: number;
}

export interface JudgeInstanceConfig {
  /** Address the judge's Ollama listens on (default 127.0.0.1). */
  host?: string;
  port?: number;
  num_ctx?: number;
  gpu?: boolean;
  models_dir?: string;
}

/** Per-field numeric rules for actors (config.json "limits"). */
export interface FieldLimit {
  min?: number;
  max?: number;
  /** Largest total change this field may undergo in one turn, whatever the model proposes. */
  max_step?: number;
}

/** Full-text replacements for the built-in prompts (config.json "prompts"), e.g. for another language. */
export interface PromptOverrides {
  extractor?: string;
  setup?: string;
  rule_judge?: string;
  invocation?: string;
  repair?: string;
  compactor?: string;
  compaction_judge?: string;
  compaction_extract?: string;
  rule_audit?: string;
  rule_confirm?: string;
}

export interface SessionRuleConfig {
  id: string;
  text: string;
  locked?: boolean;
  lift_hint?: string;
}

/** Shape of config.json (all optional). */
export interface GameConfig {
  betting?: string;
  sense?: { margin?: number; window?: number; samples?: number; bluff_below?: number; texts?: { against?: string; caught?: string } };
  vision?: { python?: string; venv?: string; script?: string; device?: "cpu" | "cuda"; idle_stop_s?: number; timeout_s?: number; pose_weights?: string; url?: string };
  terms?: { file?: string; notice?: string; remember_days?: number };
  forfeit?: { chance?: number; if?: unknown; rounds?: number; text?: string; done?: string; missed?: string; penalty?: { field?: string; add?: number } };
  world?: { era?: string; time_travel?: string; canon?: { name?: string; file?: string }; anachronism?: string; languages?: { list?: string[]; field?: string }; universe?: { name?: string; jump?: string } };
  actor_defaults_from?: Record<string, string>;
  derive?: Record<string, { from?: string; map?: Record<string, unknown>; default?: unknown }>;
  seating?: { approval?: "owner" | "none"; phases?: string[]; min_age?: number; fields?: { age?: string; gender?: string; sexuality?: string }; genders?: string[]; sexualities?: string[]; default_sexuality?: string; texts?: Record<string, string>; photo?: { required?: boolean; text_file?: string; keep_hours?: number; show?: boolean; check?: { url?: string; threshold?: number; keypoint?: number; people?: number }; texts?: Record<string, string> }; start?: { auto?: boolean; early?: boolean; texts?: Record<string, string> } };
  pay?: { field?: string; phases?: string[]; escrow?: { release_on?: string[] }; texts?: Record<string, string> };
  tips?: { amount?: string; after_hands?: number; on_leave?: boolean; npc_chance?: number; texts?: Record<string, string> };
  blinds?: { steps?: number[]; every?: number };
  audit?: { shows?: string[] };
  shuffle?: { required?: string; by?: string; ritual?: string[] };
  deal?: string;
  audience?: { role?: string; reactions?: string; max?: number; decay?: number; boost?: { at?: number; cap?: number }; seats?: string[] };
  producer?: { who?: string; role?: string; commands?: Record<string, string> };
  /** Dangers the server rolls after each round (see random-events.ts). */
  hazards?: { trigger?: string; phase?: string; file?: string; shelter?: { set?: Record<string, unknown>; text?: string }; repeat?: number; table?: { id?: string; if?: { field: string; is: string }; regions?: string[]; chance: number; seasons?: Record<string, number>; text: string; set?: Record<string, unknown> }[] };
  /** Where a player's private cards are; `/hand` shows them in the private chat only. */
  private_hands?: { field?: string };
  /** A JS file in the imeng folder that decides what happens to money held by the people of an evicted chat (exports evictBalances). */
  evict?: string;
  /** Busted players get a re-entry code; the owner may lend (see credit.ts). */
  credit?: { field?: string; empty?: number; start?: number; debt_limit?: number; code_ttl?: string; frozen_borrow?: boolean; min_antes?: number; ante?: string; reset?: Record<string, unknown>; start_from?: string; currency?: string; require_terms?: boolean; max_credit?: number };
  /** Events the server rolls after each round. */
  random_events?: { id?: string; chance: number; if?: unknown; set?: Record<string, unknown>; text: string; once?: boolean }[];
  /** Temporary ban from a table for the actor a judge or the narrator flags. */
  ban?: { hours?: number; flag_field?: string; text?: string };
  /** The magic-play judge. */
  ruling?: { phase: string; class_field?: string; question?: string; table?: Record<string, string[]>; suits?: Record<string, string>; class_suits?: Record<string, { aligned?: string[]; opposed?: string[] }> };
  /** A small call of its own for what each NPC says next. */
  voices?: { roles?: string[]; role_field?: string; skip?: string[]; max?: number; words?: number; feelings?: { warm_at?: number; warm?: string; cold?: string }; judge?: Record<string, unknown> };
  /** Names for characters that arrive without one. */
  naming?: { pool?: number; prompt?: string; role_field?: string; roles?: string[]; skip?: string[] };
  /** A card drawn by the server on every round played in `phase`. */
  deck?: { phase: string; note?: string; hand?: number };
  /** Actor fields that cannot change once set. */
  write_once?: string[];
  /** A TV-format show clock in minutes, charged per round by phase. */
  show_clock?: { judge?: boolean; jump_max?: number; total: number; per_round?: number; costs?: Record<string, number>; warn_at?: number[] };
  /** The open-question gate: who may answer. */
  question?: { field?: string; text?: string };
  /** The dating-show rules in code (attraction, eligibility). */
  dating?: { status_field?: string; age_field?: string; role_field?: string; contestant_role?: string; finale?: { pair?: string; none?: string }; notes_after?: number; npc_status?: Record<string, number> };
  /** Actor string fields that carry a character's voice: never masked by `pii`, shown to the narrator as CHARACTER VOICE. */
  tone_fields?: string[];
  /** The actor field that holds a role (default "role"). */
  role_field?: string;
  /** Which roles may have each field changed: {"warmth":["contestant"]}. */
  field_roles?: Record<string, string[]>;
  /** What a message that matches no action of the current phase gets. */
  off_phase?: { mode?: "hush" | "ignore"; texts?: string[] };
  /** A JS file in the imeng folder exporting validateOp(op, state). */
  validate?: string;
  /** Let the judge correct a refused op once (default: on when validate is set). */
  repair?: boolean;
  /** Version of this file's format (default 1); see config-schema.ts. */
  schema_version?: number;
  model_id?: string;
  icon?: string;
  initial_state?: Partial<GameState> & Record<string, unknown>;
  actor_template?: Actor;
  history_limit?: number;
  actor_history_limit?: number;
  too_long_reply?: string;
  private_only_reply?: string;
  private_guidance?: string;
  events_limit?: number;
  state_rules?: string;
  limits?: Record<string, FieldLimit>;
  exit_when?: Condition[];
  /** Ends the game for everyone still in when enough actors meet a condition (share = fraction of actors with the field, default 1 = all). */
  /** List fields whose entries are a set: a repeated push is a no-op (the first entry stays); matching ignores case and extra spaces. */
  /** Fields that may only hold one of a fixed list of values: key = "game.<field>" (one session value) or an actor field name (every actor). */
  allowed_values?: Record<string, unknown[]>;
  /** Fields that change only when the new value is set on this many turns in a row (the first value, when the field is empty, is taken at once) (key = "game.<field>" or "actors.<id>.<field>"). */
  sticky_fields?: Record<string, number>;
  /** Actor fields that change only when the narration contains a phrase (regular expression, {name} = the actor): {"score":"point to {name}"}. */
  field_evidence?: Record<string, string>;
  unique_fields?: string[];
  /** Fields that hold an actor id, besides game.current_actor. */
  actor_ref_fields?: string[];
  /** Places where things with ids live, and which fields must hold their ids. */
  id_domains?: Record<string, { at: string; key?: string; from?: string; when?: IdDomain["when"]; mint?: Mint }>;
  refs?: Record<string, { to: string; repeat?: boolean } | { keys_to: string }>;
  /** Several real people playing one game (a chat shared with Open WebUI's "Allow replies"). Off unless enabled is true. */
  multiplayer?: {
    enabled?: boolean;
    turns?: "ready" | "free" | "token" | "judged";
    gate?: boolean;
    token_field?: string;
    off_turn?: "note" | "queue";
    turn_rule?: string;
    order?: "fifo" | "filo" | "join" | "random" | { by: string; desc?: boolean };
    clock?: { field: string; unit?: "second" | "minute" | "hour" | "day" | "week" | "count" };
    tension?: { mode?: "status" | "beats"; max_words?: number; cooldown_seconds?: number };
    private?: false | { reply?: "ack" | "narrator" | "none"; narrator_sees?: boolean; max_words?: number };
    seat_days?: number;
    leave_pattern?: string;
    standing?: "private" | "any";
    default_after?: { real?: string; game?: string | number };
    default_action?: string;
    silenced_when?: unknown;
    silenced_reply?: string;
    judge?: boolean;
    confirm_pattern?: string;
    reset_on_talk?: boolean;
    min_players?: number;
    idle_minutes?: number;
    max_players?: number;
  };
  /** Facts only some people know (utils/knowledge.ts, docs/MULTIPLAYER.md section 11). Off unless enabled is true; needs multiplayer. */
  knowledge?: {
    enabled?: boolean;
    covert_with?: "judge" | "main";
    debrief?: { phases?: string[]; ask?: string; report?: string };
    overhear?: { traits?: "roll" | "none"; text?: string; base?: number; step?: number; seek?: number; nosy_field?: string; respect_field?: string };
    confirm_facts?: "player" | "off";
    match?: "name" | "judge";
    triggers?: { action?: "owner" | "none"; statement?: "owner" | "none"; candidate_turns?: number };
    leak?: "off" | "audit" | "retry" | "redact";
    transfer?: "off" | "tell" | "covert";
    notice?: "off" | "seen";
    covert_max?: number;
    notes_view?: boolean;
    max_facts?: number;
    max_chars?: number;
    audit_keep?: number;
    confirm_pattern?: string;
    cancel_pattern?: string;
    notes_pattern?: string;
    forget_pattern?: string;
    seed?: { id: string; text: string; about: string; known_by?: string[]; access?: FactAccess; watch?: string[]; discover?: FactTrigger[] }[];
  };
  /** How the Discord interface treats this game (read by the bridge; the proxy ignores it). */
  discord?: { scope?: "user" | "channel"; merge_context?: "mentions" | "reply" | "off"; history_limit?: number };
  /** Keeping the record in step with the conversation (utils/sync.ts). */
  sync?: { mode?: "off" | "detect" | "repair"; replay_turns?: number; batch?: number; similarity?: number; audit_keep?: number };
  /** Tools the narrator may call, with each one's options (see docs/TOOLS.md). Off unless listed. */
  tools?: Record<string, Record<string, unknown>>;
  /** How many model-and-tool rounds one turn may take (default 3). */
  tool_rounds?: number;
  /** Per field: normal (the default), read-only or write-only. */
  field_access?: Record<string, "normal" | "read-only" | "write-only" | null>;
  /** Ordering rules: `field` cannot go down in a turn that started with `while` true (e.g. a stain cannot be cleaned while a coating is on). */
  decrease_locks?: { field: string; while?: { field: string; gt?: number; gte?: number; lt?: number; lte?: number; eq?: number }; reason?: string }[];
  exit_group_when?: Condition[];
  /** Record what the player's message states while the narrator is still writing, so the state is current when the reply ends (default false; costs one more extractor call per turn). */
  early_sync?: boolean;
  reasoning?: "hide" | "show" | "off";
  /** Strip the server's own state/dice blocks from narration if the model echoes them (default false). */
  hide_state_echo?: boolean;
  /** Add a plain-language STATE NOTES block next to the JSON state: what changed, and a catch-up when the story and record may be out of step (default false). */
  state_notes?: boolean;
  /** Words for numeric fields, used in STATE NOTES: {"<field>": [[0,"low"],[4,"medium"],[8,"high"]]} (the word of the highest bound at or below the value). */
  field_words?: Record<string, [number, string][]>;
  /** Last resort when the prompt is still near the model's limit after compaction: tell the narrator to close the game. */
  game_turn?: { advance?: "round" | "field" | "judged"; field?: string; rule?: string; word?: string };
  images?: ImagesConfig;
  link?: { length?: number; style?: "chars" | "words"; words?: string[]; ttl?: string; max_fails?: number; texts?: Record<string, string> };
  /** Per-person numbers, booleans and ids kept in SQL and put back in the session (needs DATABASE_URL). */
  rehydrate?: { paths?: string[]; ttl?: string; notes?: Record<string, string> };
  /** Named flags compiled to a bitmask, and who may join. */
  eligibility?: { version?: number; flags?: string[]; join?: { require?: string[]; block?: string[] }; opt_in?: string; rules?: { flag: string; path: string; op: string; value?: unknown; latch?: boolean }[]; texts?: Record<string, string> };
  /** Keeps personal details out of every model, log and trace (utils/pii-filter.ts). Off unless the block exists. */
  crossings?: { phase?: string; back?: string; field?: string; places?: string[]; ambient?: string; effects?: Record<string, Record<string, [number, number]>>; min?: number; max?: number; ad_break?: { text?: string; at_crossing?: number } ; texts?: Record<string, string> };
  pii_filter?: { detect?: string[]; on_detect?: "mask" | "block" | "allow"; allow?: string[]; patterns?: { name: string; regex: string }[]; texts?: Record<string, string> };
  /** Paths of personal data (`*` = one key), masked before SQL, logs and MLflow. */
  pii?: string[];
  pii_mask?: string;
  state?: { texts?: Record<string, string> };
  /** Who owns a chat, and how it passes on. Off unless this block exists. */
  owner?: { vanish_after?: string; fallback?: "close" | "open"; answers?: "hashed" | "plain"; challenge?: ("created" | "name")[]; max_fails?: number; texts?: Record<string, string> };
  /** What players are told about telemetry (only matters when MLflow is on). */
  telemetry?: { notice?: "always" | "never"; texts?: Record<string, string> };
  freeze?: { mode?: "skip" | "npc" | "inert"; catch_up?: "none" | "public"; catch_up_chars?: number; others?: "off" | "anyone"; text?: string; texts?: Record<string, string> };
  calculated?: Record<string, { count?: string; sum?: string; min?: string; max?: string; argmax?: string; argmin?: string; where?: Record<string, unknown>; at_least?: number }>;
  phases?: Record<string, unknown>;
  goals?: Record<string, unknown>;
  turn_events?: { id?: string; at?: number; every?: number; if?: unknown; text?: string; set?: Record<string, unknown>; end?: boolean }[];
  wrap_up?: { turn_budget?: "hard" | "after_compaction"; at_tokens?: number; at_turn?: number; soon_turns?: number; soon_text?: string; text?: string; after_text?: string; over_reply?: string; credits_file?: string; on_exit?: "user" | "all" };
  /** Actor fields that hold another name a person goes by (e.g. "address_as"): they count as the person's name in the recap check, and an actor added under one of them is dropped as a duplicate. */
  alias_fields?: string[];
  /** Put STATE NOTES, CATCH-UP, WRAP UP and GAME OVER at the end of the last player message instead of the system prompt, where long chats make models ignore them (default false). */
  tail_notices?: boolean;
  /** After each reply the judge checks it against the active session rules; a violation (with a verbatim quote) is fed back to the narrator on the next turn (default false). */
  enforce_rules?: boolean;
  /** Who audits replies when enforce_rules is on: the small `judge` (default) or the `main` narrator model (stronger, thinking off). */
  rule_audit_with?: "judge" | "main";
  /** Replace old chat turns with a verified recap once the prompt gets big (default: off). */
  compaction?: { at_tokens: number; keep_turns?: number; max_chars?: number; verify?: "judge" | "fields"; verify_fields?: string[] };
  session_rules?: SessionRuleConfig[];
  /** true = the default pool; or an object of die -> how many to roll, e.g. {"d20": 4, "d6": 10}. */
  dice?: boolean | Record<string, number>;
  /** Actor id of the person typing (default "user") and prefix for generated NPC ids (default "npc_"). */
  user_id?: string;
  npc_prefix?: string;
  /** Only these actor fields may be changed by the model's ops (default: any field except server-owned ones). */
  writable_fields?: string[];
  /** Regular expression (source) that recognises the trigger sentence at the top of the system prompt. */
  trigger_pattern?: string;
  /** Extra regular expressions (sources) for placeholder text the setup judge must not record. */
  placeholder_patterns?: string[];
  prompts?: PromptOverrides;
  invocation?: "judge" | "always";
  setup_turns?: number;
  setup_hint?: string;
  judge_model?: string;
  /** Protocol of the judge server: Ollama native (default) or OpenAI-compatible (llama.cpp). */
  judge_api?: "ollama" | "openai";
  judge_confirmations?: number;
  judge_instance?: JudgeInstanceConfig;
  judge_num_ctx?: number;
  judge_actor_fields?: string[];
  judge_history_items?: number;
  judge_events?: number;
}

/** Minimal request shape the session code needs (satisfied by express' Request). */
export interface HeaderSource {
  get(name: string): string | undefined;
}

/** How a new id is made (config.json: id_domains.<name>.mint). */
export type Mint =
  | { kind: "uuid"; version?: 4 | 5 | 7; namespace?: string; of?: string }
  | { kind: "random"; alphabet?: string; length?: number }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "counter"; prefix?: string; pad?: number }
  | { kind: "timestamp"; format?: "epoch_ms" | "epoch_s" | "iso" | "compact"; prefix?: string }
  | { kind: "hash"; algo?: "md5" | "sha1" | "sha256"; of?: string; length?: number; prefix?: string };

/** A place where entities with ids live: `actors`, or a map / array of objects under game. */
export interface IdDomain {
  name: string;
  /** Path of the container, as segments: ["actors"], ["game","items"]. */
  at: string[];
  /** Array containers: the field of each entry that holds its id. Missing: the container is a map and the id is the key. */
  key?: string;
  /** The field the natural id comes from (and the default input of a hash or a name-based uuid). */
  from: string;
  /** creation: always mint. collision: the natural id, minted only if it is taken. change: mint, and again when `from` changes. */
  when: "creation" | "collision" | "change";
  /** Missing: no minting, the id is the one given (or the natural one) and a taken id is refused. */
  mint?: Mint;
}

/** A field that must hold ids of a domain. */
export interface RefRule {
  /** The written pattern, e.g. "actors.*.inventory". */
  path: string;
  pattern: string[];
  /** The field holds an id (or an array of ids) of this domain. */
  to?: string;
  /** The field is a map whose keys are ids of this domain. */
  keysTo?: string;
  /** Arrays only: may the same id appear twice? */
  repeat: boolean;
}

/** The `images` block of config.json (see utils/config-schema.ts for each key). */
export interface ImagesConfig {
  renderer: "comfyui" | "a1111" | "openai" | "ollama";
  url?: string; workflow?: string; workflow_reference?: string; model?: string;
  size?: { width: number; height: number }; steps?: number; cfg?: number; sampler?: string; strength?: number;
  prompts?: { positive?: string; negative?: string; style?: string };
  seeds?: Record<string, number>;
  reference?: { default?: string; urls?: boolean };
  ask?: { words?: string[]; offer?: string };
  process?: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; venv?: string; ready_url?: string; stop_on_exit?: boolean };
  lease?: { unload_narrator?: boolean; free_renderer?: boolean };
  max_queue?: number;
  texts?: Record<string, string>;
  /** A different judge model for the picture prompt and the offer (the game's usual judge when absent). */
  judge?: { model?: string; url?: string; api?: "ollama" | "openai"; num_ctx?: number };
  /** Actor fields given to the prompt writer for every actor, and game fields for the scene (e.g. description, outfit, gak_colors). */
  state_fields?: string[]; game_fields?: string[];
  /** Actor fields whose values must appear in the prompt of that actor's picture: added by code when the judge left them out. */
  keep_fields?: string[];
  /** A second pass that rewrites the prompt for a model that understands little language. */
  refine?: { rules?: string; max_words?: number; negations?: string[]; judge?: { model?: string; url?: string; api?: "ollama" | "openai"; num_ctx?: number } };
  /** What the person who earned it can have drawn after the game (goals.reward "keepsake"). */
  keepsake?: { options?: string[] | "judge"; theme?: string; game?: string; max_options?: number };
  /** The image censor (the vision module) run on uploaded pictures and on renders. Off when absent. */
  safety?: { model?: string; threshold?: number; labels?: string[]; uploads?: boolean; renders?: boolean };
}

/** What the images feature remembers about a session, outside the state snapshots (a rollback must not change anyone's face). */
export interface Visuals {
  /** Seed per actor id. */
  seeds: Record<string, number>;
  /** Reference image file (in the image store) per actor id. */
  refs: Record<string, string>;
  /** A picture the judge offered and the player has not answered yet. */
  offer?: { kind: "scene" | "portrait"; subject: string; actor?: string };
  /** The keepsake options (when the judge proposed them) and who has had theirs made. */
  keepsake?: { options?: string[]; claimed: Record<string, string> };
}

/** A character that is frozen: when, at which chat round, and for a player the controlled_by it had before (npc mode). */
export interface Frozen { at: number; round: number; gameAt?: number; kind: "player" | "npc"; by?: string }

/** A secret goal (utils/goals.ts). Server-owned: kept outside every snapshot, never read by the extractor, the compactor or a recap. */
export interface Goal {
  id: string;
  /** Actor id of who wants it. */
  actor: string;
  text: string;
  /** Why it matters to them, when they said (e.g. a tattoo that burns). Told to the narrator so it can respect it; the goal judge reads it too. */
  reason?: string;
  /** Written by the person, or invented for an NPC. */
  source: "player" | "invented";
  /** Marked done on this chat round, with the words from the round that show it. */
  done?: { turn: number; quote: string };
}
export interface GoalStore { goals: Goal[]; seq: number; /** Digests of private text taken as a goal: kept out of what the narrator is shown. */ consumed?: string[]; /** The reveal after the finale was told. */ revealed?: boolean; /** Reactions the narrator is told about on the next round. */ reactions?: { turn: number; actor: string }[] }
