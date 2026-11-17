import { TONE_FIELDS, config } from "./config.js";

/** config.json `pii`: paths of personal data, e.g. ["actors.*.real_name", "game.contact"]. `*` stands for one key. Redacted before anything reaches SQL, logs or MLflow. */

/** The personal paths, minus any that name a tone field (a character's voice is kept readable). */
export const PII_PATHS: string[] = (Array.isArray(config.pii) ? (config.pii as unknown[]).filter((p): p is string => typeof p === "string" && !!p) : []).filter((p) => !TONE_FIELDS.includes(p.split(".").at(-1) ?? ""));
export const PII_MASK: string = typeof config.pii_mask === "string" ? config.pii_mask : "[redacted]";

const walk = (node: unknown, parts: string[], mask: string): void => {
  if (!node || typeof node !== "object" || !parts.length) return;
  const o = node as Record<string, unknown>;
  const [head, ...rest] = parts;
  for (const k of head === "*" ? Object.keys(o) : head in o ? [head] : []) {
    if (rest.length) walk(o[k], rest, mask);
    else if (o[k] !== undefined && o[k] !== null && o[k] !== "") o[k] = mask;
  }
};

/** A copy of `value` with every listed path masked. The input is never changed. */
export function redactPii<T>(value: T, paths: string[] = PII_PATHS, mask: string = PII_MASK): T {
  if (!paths.length) return value;
  const copy = structuredClone(value);
  for (const p of paths) walk(copy, p.split("."), mask);
  return copy;
}

/** A path that a stored (persisted) list names but that is personal: the check that must fail. */
export const piiStored = (stored: string[], paths: string[] = PII_PATHS): string[] =>
  stored.filter((s) => paths.some((p) => new RegExp("^" + p.split(".").map((x) => (x === "*" ? "[^.]+" : x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.") + "$").test(s)));
