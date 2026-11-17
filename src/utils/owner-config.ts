import { config } from "./config.js";
import { parseDurationMs } from "./durations.js";

/** config.json `owner` (off unless the block exists) and `telemetry` (what players are told; only matters when MLflow is on). */

const ow: any = config.owner && typeof config.owner === "object" ? config.owner : null;
export const OWNER = ow ? {
  vanishMs: parseDurationMs(ow.vanish_after ?? "7d") ?? 7 * 86_400_000,
  fallback: (ow.fallback === "open" ? "open" : "close") as "close" | "open",
  answers: (ow.answers === "plain" ? "plain" : "hashed") as "hashed" | "plain",
  challenge: (Array.isArray(ow.challenge) ? (ow.challenge as string[]).filter((c) => c === "created" || c === "name") : ["created", "name"]) as ("created" | "name")[],
  askMs: parseDurationMs(ow.ask_after ?? "7d") ?? 7 * 86_400_000,
  // tone: successors must have said yes (/successor accept) and be rated at least `min` (0 to 1) by a small judge reading their recent messages, every `every` spoken turns. Off unless this block exists.
  tone: ow.tone && typeof ow.tone === "object" ? { min: Math.min(1, Math.max(0, Number(ow.tone.min) >= 0 ? Number(ow.tone.min) : 0.5)), every: Math.max(3, Math.floor(Number(ow.tone.every)) || 15), judge: ow.tone.judge && typeof ow.tone.judge === "object" ? ow.tone.judge : undefined } : null,
  maxFails: Math.min(50, Math.max(1, Math.floor(Number(ow.max_fails)) || 3)),
  texts: (ow.texts && typeof ow.texts === "object" ? ow.texts : {}) as Record<string, string>,
} : null;

const tm: any = config.telemetry && typeof config.telemetry === "object" ? config.telemetry : null;
export const TELEMETRY_NOTICE: "always" | "never" = tm?.notice === "never" ? "never" : "always";
const TELEMETRY_TEXTS = (tm?.texts && typeof tm.texts === "object" ? tm.texts : {}) as Record<string, string>;

const TEXTS: Record<string, string> = {
  on: "Note: this game sends traces of its model calls to an MLflow server for debugging.",
  off: "Note: telemetry is now off for this chat ({reason}). Nothing more is sent to MLflow; what was recorded before is kept.",
  on_again: "Note: telemetry is on again for this chat ({reason}). Traces of its model calls go to an MLflow server.",
  reason_owner: "the owner chose it",
  reason_server: "the server setting",
  owner: "The owner is {name}. Successors: {successors}. Telemetry: {telemetry}.",
  none: "nobody",
  no_owner: "This chat has no owner.",
  not_owner: "Only the owner, {name}, can do that.",
  unknown_who: "I don't know a person called \"{who}\" here.",
  successor_added: "{who} is now a successor (number {n}).",
  successor_removed: "{who} is no longer a successor.",
  successor_usage: "Use /successor add <name>, /successor remove <name> or /successor.",
  successors: "Successors, in order: {list}.",
  telemetry_status: "Telemetry is {state}.",
  telemetry_server_off: "Telemetry is off for the whole server; the owner cannot turn it on.",
  telemetry_unavailable: "This game does not send telemetry.",
  not_away: "The owner is not away, so there is nothing to claim.",
  not_heir: "{name} is next in line to claim this chat.",
  question_created: "On what day did this chat begin? (YYYY-MM-DD)",
  question_name: "What name did the first owner use?",
  wrong: "That is not right. {left} tries left.",
  locked: "Too many wrong answers. This stays locked until the owner returns.",
  claimed: "{name} is now the owner of this chat.",
  closed: "The owner has been away and nobody can take over, so this chat is closed.",
  ask: "{owner}, this room has been yours for a while. Keep it with /keep, or hand it over with /handover <name>. Suggested: {list}.",
  kept: "{name} keeps the room.",
  handed: "{name} is now the owner of this chat (handed over by {old}).",
  handover_usage: "Use /handover <name>.",
  not_asked: "Nobody is asking you anything right now.",
  accepted: "Thanks: you may be considered as a successor. Your messages are not kept, only a score.", declined: "Understood: you will not be considered, and nothing about you is kept for it.",
  owner_cannot: "You are the owner.", not_consented: "{who} has not agreed to be considered (they can send /successor accept).", tone_low: "{who} is not rated high enough to be a successor right now.",
  usage_claim: "Answer the question with /claim <answer>.",
};
const fill = (t: string, v: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");
export const ownerText = (key: string, v: Record<string, string> = {}): string => fill(OWNER?.texts[key] ?? TELEMETRY_TEXTS[key] ?? TEXTS[key] ?? key, v);
export const telemetryText = (key: string, v: Record<string, string> = {}): string => fill(TELEMETRY_TEXTS[key] ?? OWNER?.texts[key] ?? TEXTS[key] ?? key, v);
