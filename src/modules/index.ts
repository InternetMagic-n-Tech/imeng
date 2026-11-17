import type { Express } from "express";

/**
 * Interfaces: the ways people reach the game. Each lives in modules/<name>/ and exports a default InterfaceModule. The engine (engine.ts) does not
 * know which one a message came from: a module turns its platform's message into an Inbound, hands the engine a Sink to answer through
 * (utils/sink.ts), and the engine does the rest.
 *
 * Choose which run with INTERFACES (comma list, default "openwebui"). To add one: create modules/<name>/index.ts, add it to REGISTRY below,
 * list what it cannot do in `missing` (those are logged once at start, never errors), and map the platform's ids onto the identity the
 * engine reads (Inbound.get: "x-openwebui-chat-id", "x-openwebui-user-id", "x-openwebui-user-name").
 */
export interface InterfaceModule {
  name: string;
  /** Features the Open WebUI interface has that this one lacks (for example "streaming", "regenerate"): logged once at start. */
  missing?: string[];
  start(ctx: { app: Express }): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export const REGISTRY: Record<string, () => Promise<{ default: InterfaceModule }>> = {
  openwebui: () => import("./openwebui/index.js"),
  discord: () => import("./discord/index.js"),
};

const started: InterfaceModule[] = [];

/** Say what an interface cannot do, once. */
export function logMissing(mod: InterfaceModule): void {
  for (const f of mod.missing ?? []) console.log(`[interface ${mod.name}] missing feature: ${f}`);
}

/** Start the named interfaces (Open WebUI's routes are mounted by app.ts at import, so tests and the server see them at once). */
export async function startInterfaces(app: Express, names: string[], skip: string[] = []): Promise<void> {
  for (const name of names) {
    if (skip.includes(name)) continue;
    const load = REGISTRY[name];
    if (!load) { console.warn(`INTERFACES: unknown interface "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`); continue; }
    const mod = (await load()).default;
    logMissing(mod);
    await mod.start({ app });
    started.push(mod);
  }
}

export async function stopInterfaces(): Promise<void> {
  for (const m of started.splice(0)) { try { await m.stop?.(); } catch (e) { console.warn(`interface ${m.name} did not stop cleanly:`, (e as Error).message); } }
}
