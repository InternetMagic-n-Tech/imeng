import { z } from "zod";
import type { Actor, GameState } from "./types.js";

/**
 * Exit conditions as a small declarative tree: comparisons (leaf), aggregates over the actors still in, and
 * AND / OR / NOT around them. Plain JSON in config.json, checked by zod, evaluated here; never code, never the model.
 * Old rules ({field, lte|gte, share?, reason?}) are leaves and mean what they always did.
 */

export type Aggregate = "avg" | "min" | "max" | "sum" | "top_count";
export interface Compare { lt?: number; lte?: number; gt?: number; gte?: number; eq?: number }
export interface Leaf extends Compare { field: string; aggregate?: Aggregate; share?: number; reason?: string; present?: boolean; is?: string | number | boolean }
export interface Logic { logic: "AND" | "OR" | "NOT"; conditions: Condition[]; reason?: string }
export type Condition = Leaf | Logic;

export const MAX_DEPTH = 6;
const num = z.number();
const cmp = { lt: num.optional(), lte: num.optional(), gt: num.optional(), gte: num.optional(), eq: num.optional() };
const leafSchema = z.object({
  field: z.string().describe("Actor field; `game.<field>` reads a number from the shared game state."),
  aggregate: z.enum(["avg", "min", "max", "sum", "top_count"]).optional().describe("Compare the average / minimum / maximum / sum of the field over the actors still in, instead of one actor. top_count: how many of them share the highest value (2 or more is a tie at the top)."),
  share: num.optional().describe("exit_group_when only, without `aggregate`: fraction (0-1, default 1) of the actors still in that must meet the comparison."),
  ...cmp,
  present: z.boolean().optional().describe("true: the field has a value (not empty, not missing); false: it has none. Works on text, lists and numbers."),
  is: z.union([z.string(), z.number(), z.boolean()]).optional().describe("The field is exactly this value (text, number or true/false)."),
  reason: z.string().optional().describe("Words for the narrator when this is what is still missing (phases.require)."),
});
export const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ logic: z.enum(["AND", "OR", "NOT"]), conditions: z.array(conditionSchema), reason: z.string().optional() }),
  leafSchema,
]));

export const isLogic = (c: Condition): c is Logic => "logic" in c;

const hasValue = (v: unknown): boolean => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
const numeric = (c: Compare): boolean => [c.lt, c.lte, c.gt, c.gte, c.eq].some((x) => typeof x === "number");

/** Does any value (text, list, number) meet a leaf? Numeric comparisons need a number; `present` and `is` work on anything; all given tests must hold. */
export function valueMeets(v: unknown, c: Leaf | Compare): boolean {
  const l = c as Leaf;
  if (l.present !== undefined && hasValue(v) !== l.present) return false;
  if (l.is !== undefined && v !== l.is) return false;
  if (numeric(c)) return typeof v === "number" && meets(v, c);
  return l.present !== undefined || l.is !== undefined;
}

/** Does a number meet the comparisons on a leaf? lte/gte alone: either one (the old rule); with lt/gt/eq every given one must hold. */
function meets(v: number, c: Compare): boolean {
  if (c.lt === undefined && c.gt === undefined && c.eq === undefined) return (c.lte !== undefined && v <= c.lte) || (c.gte !== undefined && v >= c.gte);
  return (c.lt === undefined || v < c.lt) && (c.lte === undefined || v <= c.lte) && (c.gt === undefined || v > c.gt) && (c.gte === undefined || v >= c.gte) && (c.eq === undefined || v === c.eq);
}

export const hasCompare = (c: Compare): boolean => numeric(c) || typeof (c as Leaf).present === "boolean" || (c as Leaf).is !== undefined;

/** Read a dotted path below `game` ("calc.goals_done"). */
const readGame = (state: GameState, rest: string): unknown => rest.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), state.game);

/** Actors still in the game. */
export function activeActors(state: GameState): [string, Actor][] {
  const gone = new Set((state.game.exited_game || []).map((e) => e.id));
  return Object.entries(state.actors || {}).filter(([id]) => !gone.has(id));
}

const nums = (xs: unknown[]): number[] => xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

/**
 * Evaluate a condition. With `actor`, a plain leaf reads that actor's field (exit_when); without, a plain leaf
 * is true when `share` of the actors still in meet it (exit_group_when). Aggregates and `game.` fields look at the
 * whole table either way. Missing or non-numeric values make a leaf false; too-deep trees are false.
 */
export function evalCondition(c: Condition, state: GameState, actor?: Actor, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (isLogic(c)) {
    const parts = Array.isArray(c.conditions) ? c.conditions : [];
    if (c.logic === "NOT") return parts.length === 1 && !evalCondition(parts[0], state, actor, depth + 1);
    if (!parts.length) return false;
    return c.logic === "AND" ? parts.every((p) => evalCondition(p, state, actor, depth + 1)) : parts.some((p) => evalCondition(p, state, actor, depth + 1));
  }
  if (c.field.startsWith("game.")) {
    const v = readGame(state, c.field.slice(5));
    if (c.aggregate && v && typeof v === "object" && !Array.isArray(v)) return aggregateMeets(nums(Object.values(v)), c); // a calculated map (id -> number)
    return valueMeets(v, c);
  }
  if (c.aggregate) {
    return aggregateMeets(nums(activeActors(state).map(([, a]) => a?.[c.field])), c);
  }
  if (actor) return valueMeets(actor[c.field], c);
  if (c.present !== undefined || c.is !== undefined) {
    const all = activeActors(state).map(([, a]) => a?.[c.field]);
    return all.length > 0 && all.filter((x) => valueMeets(x, c)).length / all.length >= (c.share ?? 1);
  }
  const v = nums(activeActors(state).map(([, a]) => a?.[c.field]));
  return v.length > 0 && v.filter((x) => meets(x, c)).length / v.length >= (c.share ?? 1);
}

function aggregateMeets(v: number[], c: Leaf): boolean {
  if (!v.length) return false;
  const sum = v.reduce((x, y) => x + y, 0);
  const top = Math.max(...v);
  return meets(c.aggregate === "avg" ? sum / v.length : c.aggregate === "sum" ? sum : c.aggregate === "min" ? Math.min(...v) : c.aggregate === "top_count" ? v.filter((x) => x === top).length : top, c);
}

/** Config problems in one rule (empty = fine). `perActor` is exit_when: no `share`. */
export function conditionProblems(c: unknown, perActor: boolean, depth = 0): string[] {
  if (!c || typeof c !== "object") return ["a condition must be an object"];
  if (depth > MAX_DEPTH) return [`conditions are nested deeper than ${MAX_DEPTH}`];
  const o = c as Record<string, any>;
  if ("logic" in o) {
    if (!["AND", "OR", "NOT"].includes(o.logic)) return ['`logic` must be "AND", "OR" or "NOT"'];
    if (!Array.isArray(o.conditions) || !o.conditions.length) return [`${o.logic} needs a non-empty \`conditions\` list`];
    if (o.logic === "NOT" && o.conditions.length !== 1) return ["NOT takes exactly one condition"];
    return o.conditions.flatMap((x: unknown) => conditionProblems(x, perActor, depth + 1));
  }
  const out: string[] = [];
  if (typeof o.field !== "string" || !o.field) out.push("a condition needs a field");
  if (!hasCompare(o)) out.push(`the condition on "${o.field}" needs lt, lte, gt, gte, eq, present or is`);
  if (o.share !== undefined) {
    if (perActor) out.push(`\`share\` on "${o.field}" only works in exit_group_when`);
    else if (o.aggregate) out.push(`\`share\` on "${o.field}" does nothing with \`aggregate\``);
    else if (!(o.share > 0 && o.share <= 1)) out.push("share must be above 0 and at most 1");
  }
  return out;
}
