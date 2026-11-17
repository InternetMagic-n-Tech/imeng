import type { GameState } from "../utils/types.js";

/**
 * Tools the narrator may call (OpenAI-style function calling: a name, a description and a JSON Schema for the arguments). A game opts in to each
 * tool in config.json (`tools`), and options there narrow what it may do (hosts, limits). Secrets and endpoints live in tools.config.mjs, never in
 * config.json and never in front of the model. A tool does its network through `ctx.http`, which the engine has already bound to the tool's policy.
 */

export interface HttpResult { status: number; contentType: string; text: string; url: string; truncated: boolean }

export interface ToolContext {
  /** The player turn this call belongs to. */
  turn: number;
  /** The game state as the narrator saw it at the start of the turn (read only). */
  state: GameState;
  /** What config.json says for this tool: `tools.<name>`. */
  options: Record<string, any>;
  /** What tools.config.mjs says for this tool: keys, endpoints. */
  secrets: Record<string, any>;
  /** HTTP limited by this tool's policy (allowed hosts, size, time, no private addresses). The only network a tool may use. */
  http(url: string, init?: { method?: string; headers?: Record<string, string> }): Promise<HttpResult>;
  /** This tool's own state, saved with the session (a journal, a clock). */
  store: { get<T>(): T | undefined; set(value: unknown): void };
  now(): number;
}

export interface ToolDef {
  name: string;
  /** Short: every tool schema costs context. */
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** The network this tool needs, from its options and secrets (null: none through ctx.http). Defaults are conservative. */
  network?(options: Record<string, any>, secrets: Record<string, any>): { hosts: string[]; allowPrivate?: boolean; allowHttp?: boolean; methods?: string[]; maxBytes?: number; timeoutMs?: number } | null;
  run(args: any, ctx: ToolContext): Promise<unknown>;
}

/** Tools by name; each is loaded only when a game uses it (so an unused tool's dependencies are never required). */
export const REGISTRY: Record<string, () => Promise<ToolDef>> = {
  fetch: async () => (await import("./fetch.js")).default,
  web_search: async () => (await import("./web_search.js")).default,
  tmdb: async () => (await import("./tmdb.js")).default,
  stock: async () => (await import("./stock.js")).default,
  poker: async () => (await import("./poker.js")).default,
  db: async () => (await import("./db.js")).default,
};
