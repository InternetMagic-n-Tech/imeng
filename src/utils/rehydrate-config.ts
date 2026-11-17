import { config } from "./config.js";
import { parseDurationMs } from "./durations.js";

/** config.json `rehydrate` (off unless it lists paths). Only actors.*.<field> paths: * is the person's own actor. */
const r: any = config.rehydrate && typeof config.rehydrate === "object" ? config.rehydrate : null;
const paths: string[] = r && Array.isArray(r.paths) ? r.paths.filter((p: unknown): p is string => typeof p === "string" && /^actors\.\*\.[\w]+$/.test(p)) : [];
export const REHYDRATE = paths.length ? { paths, ttlMs: parseDurationMs(r.ttl ?? "30d") ?? 30 * 86_400_000, notes: (r.notes && typeof r.notes === "object" ? r.notes : {}) as Record<string, string> } : null;
