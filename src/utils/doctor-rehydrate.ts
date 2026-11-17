import { piiStored } from "./pii.js";
import type { Finding, Sys, Settings } from "./doctor.js";

/** Doctor checks for config.json `rehydrate`, `eligibility` and `pii_filter`. Nothing is reported when all are absent. */

const f = (level: Finding["level"], id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level, title, detail, fix });

export async function checkRehydrate({ s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  const out: Finding[] = [];
  const rh = s.game.rehydrate, el = s.game.eligibility, pf = s.game.pii_filter;
  if (pf) {
    const badRe = (pf.patterns ?? []).filter((p) => { try { new RegExp(p.regex); return !/^[a-z][a-z0-9_]*$/.test(p.name); } catch { return true; } }).map((p) => p.name);
    out.push(badRe.length ? f("fail", "pii-filter-config", "config.json pii_filter has bad patterns", badRe.join(", "), "A pattern needs a name (a-z, 0-9, _) and a valid regex.") : f("ok", "pii-filter-config", `PII filter: ${pf.on_detect ?? "mask"}`));
    if (!s.piiSalt) out.push(f("warn", "pii-filter-salt", "PII_SALT is not set", "The tokens are salted hashes; without a secret salt a phone number or email could be guessed back from a token.", "Set PII_SALT to a long random string."));
  }
  if ((s.game.deal === "server" || s.game.betting === "server") && !s.databaseUrl) out.push(f("fail", "server-deal-db", "deal / betting \"server\" need DATABASE_URL", "The proxy refuses to start: the hands are copied to the database (hand_log) and the table pauses without it.", "Set DATABASE_URL (see docs/DEPLOYMENT.md)."));
  if (s.game.forfeit && !s.databaseUrl) out.push(f("warn", "forfeit-db", "forfeit without DATABASE_URL", "A picture a player sends is kept (and replaced by a placeholder) only with a database or bucket; without one it travels to the narrator model like any attachment.", "Set DATABASE_URL, or drop forfeit."));
  if (!rh && !el) return out;
  if (!s.databaseUrl) out.push(f("fail", "rehydrate-db", "rehydrate / eligibility need DATABASE_URL", "Nothing is stored or checked without the database.", "Set DATABASE_URL (see docs/DEPLOYMENT.md)."));
  if (rh) {
    const paths = rh.paths ?? [];
    const bad = paths.filter((p) => !/^actors\.\*\.\w+$/.test(p));
    const pii = piiStored(paths, s.game.pii ?? []);
    const problems = [...(bad.length ? [`not of the form actors.*.<field>: ${bad.join(", ")}`] : []), ...(pii.length ? [`marked personal in pii: ${pii.join(", ")}`] : []), ...(!paths.length ? ["no paths"] : [])];
    out.push(problems.length ? f("fail", "rehydrate-config", "config.json rehydrate has problems", problems.join("; "), "Keep only numbers, booleans, enums and ids, as actors.*.<field>.") : f("ok", "rehydrate-config", `Rehydrate keeps ${paths.length} value(s) per person`));
    const orphan = Object.keys(rh.notes ?? {}).filter((p) => !paths.includes(p));
    if (orphan.length) out.push(f("warn", "rehydrate-notes", "rehydrate.notes names paths that are not kept", orphan.join(", "), "Add them to rehydrate.paths or remove the notes."));
  }
  if (el) {
    const flags = el.flags ?? [];
    const names = new Set(flags);
    const problems: string[] = [];
    if (!flags.length) problems.push("no flags");
    if (flags.length > 31) problems.push("more than 31 flags");
    if (names.size !== flags.length) problems.push("duplicate flags");
    const badName = flags.filter((x) => !/^[a-z][a-z0-9_]*$/.test(x));
    if (badName.length) problems.push(`flag names must be a-z, 0-9, _: ${badName.join(", ")}`);
    const used = [...(el.join?.require ?? []), ...(el.join?.block ?? []), ...(el.opt_in ? [el.opt_in] : []), ...(el.rules ?? []).map((r) => r.flag)];
    const unknown = used.filter((x) => !names.has(x));
    if (unknown.length) problems.push(`unknown flags used: ${[...new Set(unknown)].join(", ")}`);
    const badRule = (el.rules ?? []).filter((r) => !/^actors\.\*\.\w+$/.test(r.path)).map((r) => r.path);
    if (badRule.length) problems.push(`rule paths must be actors.*.<field>: ${badRule.join(", ")}`);
    out.push(problems.length ? f("fail", "eligibility-config", "config.json eligibility has problems", problems.join("; ")) : f("ok", "eligibility-config", `Eligibility: ${flags.length} flag(s), version ${el.version ?? 1}`));
    if (el.opt_in === undefined && (el.join?.require ?? []).length) out.push(f("info", "eligibility-optin", "Nobody can set the required flags by command", "Without opt_in the flags are set by rules or by something outside the game."));
  }
  return out;
}
