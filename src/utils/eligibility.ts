import type { Db } from "./db.js";
import { compare, read } from "./case-checks.js";
import { GAME_ID, eligibilityText, type EligibilityCfg } from "./eligibility-config.js";
import type { GameState } from "./types.js";

/** Named flags kept as a bitmask (position = place in config.json `flags`; append new flags at the end, bump `version` to rename or remove). */

export const bit = (cfg: EligibilityCfg, flag: string): number => { const i = cfg.flags.indexOf(flag); return i < 0 ? 0 : 1 << i; };
export const maskOf = (cfg: EligibilityCfg, names: string[]): number => names.reduce((m, n) => m | bit(cfg, n), 0);
export const namesOf = (cfg: EligibilityCfg, mask: number): string[] => cfg.flags.filter((f) => (mask & bit(cfg, f)) !== 0);

/** Joining needs every `require` flag and no `block` flag. */
export function joinCheck(cfg: EligibilityCfg, mask: number): { ok: boolean; missing: string[]; blocked: string[] } {
  const missing = cfg.require.filter((f) => !(mask & bit(cfg, f)));
  const blocked = cfg.block.filter((f) => mask & bit(cfg, f));
  return { ok: !missing.length && !blocked.length, missing, blocked };
}

export function joinRefusal(cfg: EligibilityCfg, mask: number): string | null {
  const r = joinCheck(cfg, mask);
  if (r.ok) return null;
  const parts = [...(r.missing.length ? [eligibilityText("missing", { list: r.missing.join(", ") })] : []), ...(r.blocked.length ? [eligibilityText("blocked", { list: r.blocked.join(", ") })] : [])];
  return eligibilityText("cannot_join", { missing: parts.join("; ") });
}

/** A person's mask. A row of another version counts as empty (db:migrate resets those rows). */
export async function getMask(db: Db, cfg: EligibilityCfg, userId: string, now: number, game = GAME_ID): Promise<number> {
  const r = await db.selectFrom("eligibility").select(["mask", "version"]).where("user_id", "=", userId).where("game", "=", game).where("expires_at", ">", now).executeTakeFirst();
  return r && Number(r.version) === cfg.version ? Number(r.mask) : 0;
}

export async function putMask(db: Db, cfg: EligibilityCfg, userId: string, mask: number, now: number, game = GAME_ID): Promise<void> {
  const row = { user_id: userId, game, mask, version: cfg.version, updated_at: now, expires_at: now + cfg.ttlMs };
  await db.insertInto("eligibility").values(row).onConflict((oc) => oc.columns(["user_id", "game"]).doUpdateSet({ mask, version: cfg.version, updated_at: now, expires_at: row.expires_at })).execute();
}

export async function setFlag(db: Db, cfg: EligibilityCfg, userId: string, flag: string, on: boolean, now: number, game = GAME_ID): Promise<number> {
  const cur = await getMask(db, cfg, userId, now, game);
  const next = on ? cur | bit(cfg, flag) : cur & ~bit(cfg, flag);
  if (next !== cur || !cur) await putMask(db, cfg, userId, next, now, game);
  return next;
}

/** The game's own rules (config.json `rules`) applied to one player's actor: a flag goes on while the condition holds (or for good when `latch`). Returns the new mask. */
export async function applyRules(db: Db, cfg: EligibilityCfg, userId: string, actor: string, state: GameState, now: number, game = GAME_ID): Promise<number> {
  const cur = await getMask(db, cfg, userId, now, game);
  let next = cur;
  for (const r of cfg.rules) {
    const holds = compare(r.op, read(state, r.path.replace("*", actor)), r.value);
    if (holds) next |= bit(cfg, r.flag);
    else if (!r.latch) next &= ~bit(cfg, r.flag);
  }
  if (next !== cur) await putMask(db, cfg, userId, next, now, game);
  return next;
}
