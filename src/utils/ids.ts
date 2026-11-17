import crypto from "node:crypto";
import { norm } from "./text.js";
import type { Mint } from "./types.js";

/**
 * Making ids. A "mint" (config.json: id_domains.<name>.mint) says how a new id is made. Everything random or time-based goes
 * through `source`, so tests can pin it. An id never contains a dot or whitespace (paths are split on dots).
 */

export const source = {
  now: (): number => Date.now(),
  bytes: (n: number): Buffer => crypto.randomBytes(n),
};
/** Tests: replace the clock and/or the random bytes (call with no argument to restore). */
export function setIdSource(s: Partial<typeof source> = {}): void {
  source.now = s.now ?? (() => Date.now());
  source.bytes = s.bytes ?? ((n) => crypto.randomBytes(n));
}

export const ALPHABETS: Record<string, string> = {
  digits: "0123456789",
  hex: "0123456789abcdef",
  base32: "abcdefghijklmnopqrstuvwxyz234567",
  base36: "0123456789abcdefghijklmnopqrstuvwxyz",
  base58: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
  base62: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
};
/** A named alphabet, or the characters given (at least 2 different ones). */
export function alphabetOf(a: string | undefined): string {
  const chars = ALPHABETS[a ?? "base62"] ?? a!;
  const uniq = [...new Set([...chars])].join("");
  if (uniq.length < 2) throw new Error(`alphabet "${a}" needs at least 2 different characters`);
  return uniq;
}

/** `length` characters of `alphabet`, without modulo bias. */
function randomString(alphabet: string, length: number): string {
  const chars = [...alphabet];
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length) {
    for (const b of source.bytes(length * 2)) {
      if (b < limit && out.length < length) out += chars[b % chars.length];
    }
  }
  return out;
}

const hex = (b: Buffer): string => b.toString("hex");
const asUuid = (h: string): string => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuid(version: number, name: string, namespace: string): string {
  if (version === 4) {
    const b = Buffer.from(source.bytes(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    return asUuid(hex(b));
  }
  if (version === 7) {
    const b = Buffer.from(source.bytes(16)), ms = BigInt(source.now());
    for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
    b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
    return asUuid(hex(b));
  }
  if (version === 5) { // the same name in the same namespace always gives the same id
    const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
    if (ns.length !== 16) throw new Error("uuid namespace must be a UUID");
    const h = crypto.createHash("sha1").update(ns).update(name).digest();
    h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
    return asUuid(hex(h.subarray(0, 16)));
  }
  throw new Error(`uuid version ${version} is not supported (4, 5 or 7)`);
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
function stamp(format: string): string {
  const t = source.now();
  if (format === "epoch_ms") return String(t);
  if (format === "epoch_s") return String(Math.floor(t / 1000));
  const d = new Date(t);
  const parts = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1, 2), pad(d.getUTCDate(), 2), pad(d.getUTCHours(), 2), pad(d.getUTCMinutes(), 2), pad(d.getUTCSeconds(), 2), pad(d.getUTCMilliseconds(), 3)];
  if (format === "compact") return parts.join("");
  if (format === "iso") return `${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}-${parts[4]}-${parts[5]}-${parts[6]}Z`; // no ":" or "."
  throw new Error(`unknown timestamp format ${format}`);
}

export interface MintContext {
  /** The new entry's fields (what `from`, `of` and hashes read). */
  fields: Record<string, unknown>;
  /** The field the natural id comes from (the default for `of`). */
  from: string;
  /** Ids already in the domain. */
  ids: string[];
}

/** One candidate id (it may already be taken: see mintId). */
function candidate(m: Mint, ctx: MintContext): string {
  const field = (name: string | undefined): string => {
    const v = ctx.fields[name || ctx.from];
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`id needs the field "${name || ctx.from}"`);
    return norm(v);
  };
  switch (m.kind) {
    case "uuid": return uuid(m.version ?? 4, m.version === 5 ? field(m.of) : "", m.namespace ?? DNS_NAMESPACE);
    case "random": return randomString(alphabetOf(m.alphabet), Math.max(1, Math.min(64, m.length ?? 8)));
    case "number": {
      const min = Math.ceil(m.min ?? 1), max = Math.floor(m.max ?? 999999);
      if (!(max >= min) || !Number.isSafeInteger(max - min + 1)) throw new Error("number needs min <= max");
      const span = max - min + 1;
      const bytes = Math.max(1, Math.ceil(Math.log2(span + 1) / 8)) + 1; // spare byte keeps the bias negligible
      let n = 0; for (const b of source.bytes(bytes)) n = n * 256 + b;
      return String(min + (n % span));
    }
    case "counter": { // one more than the highest number already used after the prefix
      const prefix = m.prefix ?? "";
      let top = 0;
      for (const id of ctx.ids) if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) top = Math.max(top, Number(id.slice(prefix.length)));
      return prefix + pad(top + 1, m.pad ?? 1);
    }
    case "timestamp": return (m.prefix ?? "") + stamp(m.format ?? "epoch_ms");
    case "hash": {
      const h = crypto.createHash(m.algo ?? "sha256").update(field(m.of)).digest("hex");
      return (m.prefix ?? "") + h.slice(0, m.length && m.length > 0 ? m.length : h.length);
    }
    default: throw new Error(`unknown id kind ${(m as { kind?: string }).kind}`);
  }
}

/**
 * A new id that is not already in `ctx.ids`. A random kind is drawn again if it hits one; a kind that would give the same id
 * again (a hash of the same name, a timestamp in the same millisecond) gets "-2", "-3"... after it.
 */
export function mintId(m: Mint, ctx: MintContext): string {
  const taken = new Set(ctx.ids);
  let base = "";
  for (let i = 0; i < 8; i++) {
    base = candidate(m, ctx);
    if (!taken.has(base)) return base;
  }
  for (let n = 2; n < 10000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error("could not make a free id");
}
