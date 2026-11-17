import type { Db } from "./db.js";
import { read } from "./case-checks.js";
import { GAME_ID } from "./eligibility-config.js";
import type { GameState } from "./types.js";

/**
 * Per-person values kept in SQL (SQL is the bookkeeper, the session is the live copy). `pull` puts the stored values back into the state when the person is
 * here (a returning player, or something outside the game changed a row) and returns the "since you slept" lines; `push` writes what changed during the game.
 */
export interface Rehydrate { paths: string[]; ttlMs: number; notes: Record<string, string> }

const concrete = (path: string, actor: string): string => path.replace("*", actor);
const write = (state: GameState, path: string, value: unknown): void => {
  const parts = path.split(".");
  const last = parts.pop()!;
  const target = parts.reduce<any>((o, k) => o?.[k], state);
  if (target && typeof target === "object") target[last] = value;
};
const fill = (t: string, v: Record<string, unknown>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? ""));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const storable = (v: unknown): boolean => typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 80);

export async function pull(db: Db, cfg: Rehydrate, c: { userId: string; actor: string; state: GameState; now: number; game?: string }): Promise<string[]> {
  const game = c.game ?? GAME_ID;
  const rows = await db.selectFrom("player_state").select(["path", "value", "source"]).where("user_id", "=", c.userId).where("game", "=", game).where("expires_at", ">", c.now).execute();
  const notes: string[] = [];
  const name = String((c.state.actors[c.actor] as { name?: unknown } | undefined)?.name ?? c.actor);
  let told = false;
  for (const p of cfg.paths) {
    const path = concrete(p, c.actor);
    const row = rows.find((r) => r.path === path);
    if (!row || !c.state.actors[c.actor]) continue;
    let value: unknown;
    try { value = JSON.parse(String(row.value)); } catch { continue; }
    const old = read(c.state, path);
    if (!same(old, value)) write(c.state, path, value);
    if (row.source === "external") {
      told = true;
      if (!same(old, value) && cfg.notes[p]) notes.push(fill(cfg.notes[p], { name, value, old, path }));
    }
  }
  if (told) await db.updateTable("player_state").set({ source: "game" }).where("user_id", "=", c.userId).where("game", "=", game).where("source", "=", "external").execute();
  if (rows.length) await db.updateTable("player_state").set({ expires_at: c.now + cfg.ttlMs }).where("user_id", "=", c.userId).where("game", "=", game).execute();
  return notes;
}

/** Writes the values that changed. Returns how many rows were written. */
export async function push(db: Db, cfg: Rehydrate, c: { userId: string; actor: string; state: GameState; now: number; game?: string }): Promise<number> {
  const game = c.game ?? GAME_ID;
  if (!c.state.actors[c.actor]) return 0;
  const rows = await db.selectFrom("player_state").select(["path", "value"]).where("user_id", "=", c.userId).where("game", "=", game).execute();
  let n = 0;
  for (const p of cfg.paths) {
    const path = concrete(p, c.actor);
    const value = read(c.state, path);
    if (!storable(value)) continue;
    const stored = rows.find((r) => r.path === path);
    if (stored && same(JSON.parse(String(stored.value)), value)) continue;
    const row = { user_id: c.userId, game, path, value: JSON.stringify(value), source: "game", updated_at: c.now, expires_at: c.now + cfg.ttlMs };
    await db.insertInto("player_state").values(row).onConflict((oc) => oc.columns(["user_id", "game", "path"]).doUpdateSet({ value: row.value, source: "game", updated_at: c.now, expires_at: row.expires_at })).execute();
    n++;
  }
  return n;
}
