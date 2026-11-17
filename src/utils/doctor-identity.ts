import type { Finding, Sys, Settings } from "./doctor.js";

/** Doctor checks for the config.json `link` and `freeze` blocks. Nothing is reported when both are absent. */

const f = (level: Finding["level"], id: string, title: string, detail?: string, fix?: string): Finding => ({ id, level, title, detail, fix });

export async function checkIdentity({ s }: { sys: Sys; s: Settings }): Promise<Finding[]> {
  const out: Finding[] = [];
  const lk = s.game.link, fz = s.game.freeze;
  if (lk) {
    const problems: string[] = [];
    if (lk.style === "words") {
      const w = lk.words ?? [];
      if (w.length < 16) problems.push(`link.words has ${w.length} words; at least 16 are needed`);
      if (w.some((x) => x.includes("-") || /\s/.test(x))) problems.push("link.words must not contain hyphens or spaces");
      if (new Set(w.map((x) => x.toLowerCase())).size !== w.length) problems.push("link.words has duplicates");
    }
    out.push(problems.length ? f("fail", "link-config", "config.json link has problems", problems.join("; "), "Fix the link block.") : f("ok", "link-config", `Link codes: ${lk.style ?? "chars"}`));
    out.push(f("info", "link-discord", "Link codes sent to Discord users go by direct message", "They must redeem the code in a DM with the bot, and the bot needs `dms: true`."));
  }
  if (fz) {
    out.push(f("ok", "freeze-config", `Freeze: ${fz.mode ?? "skip"}, catch-up ${fz.catch_up ?? "none"}`));
    if (fz.mode === "npc" && !s.game.multiplayer) out.push(f("info", "freeze-solo", "freeze mode npc only matters at a shared table", "Alone, the player is the only one there."));
  }
  return out;
}
