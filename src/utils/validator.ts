import fs from "node:fs";
import path from "node:path";
import type { GameState, Op } from "./types.js";

/**
 * A per-imeng check of every op before it is applied: a JS module named by config.json `validate` (a file inside the imeng folder) that exports
 * `validateOp(op, state)` returning true, or a short reason the op is not allowed. Real functions, so an app can say what a schema cannot ("a
 * bet cannot exceed the player's chips"), and may call its own zod schemas inside. A throw counts as a rejection. The engine's own schema checks
 * always run too.
 */
export type OpValidator = (op: Op, state: GameState) => true | string | undefined | void;

export async function loadValidator(dir: string, file: string | undefined): Promise<OpValidator | null> {
  if (!file) return null;
  const p = path.resolve(dir, file);
  if (p !== path.resolve(dir) && !p.startsWith(path.resolve(dir) + path.sep)) throw new Error(`validate "${file}" must be a file inside the imeng folder`);
  if (!fs.existsSync(p)) throw new Error(`validate: ${file} not found in ${dir}`);
  const mod: any = await import(/* @vite-ignore */ p);
  const fn = mod.validateOp ?? mod.default;
  if (typeof fn !== "function") throw new Error(`validate: ${file} must export a function validateOp(op, state)`);
  return fn as OpValidator;
}

/** The reason the validator rejects the op, or null when it is fine. */
export function runValidator(v: OpValidator, op: Op, state: GameState): string | null {
  try {
    const r = v(op, state);
    return r === true || r === undefined ? null : typeof r === "string" && r ? r : "rejected by the imeng's validator";
  } catch (e) { return `the validator failed: ${(e as Error).message}`; }
}
