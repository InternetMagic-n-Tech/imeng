import fs from "node:fs";
import path from "node:path";
import { gameFolders, readGameFile } from "./game-file.js";

/**
 * What this server can run, built from the imengs folder in code (no model): each imeng's launch words (the quoted `Imeng: ...` phrases at the
 * top of its SYSTEM_PROMPT.md) and its `description` setting. Flavours (variants of one game) that share a launch word are listed once.
 * Someone who has not used a launch word and asks what this is gets this text.
 */
export interface CatalogEntry { launch: string[]; description: string; flavours: string[] }

/** The launch words a prompt names in its opening lines ("Imeng: X" in quotes); a word given as a misspelling is skipped. */
export function launchWords(prompt: string): string[] {
  const head = prompt.slice(0, 800).split("\n")[0] ?? "";
  const clean = head.replace(/\((?:or )?the misspelling[^)]*\)/gi, "");
  return [...clean.matchAll(/["“]([^"”]*:[^"”]+)["”]/g)].map((m) => m[1]!.trim());
}

const firstParagraph = (prompt: string): string => (prompt.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !/^If the user's first message/i.test(p)) ?? "").replace(/\s+/g, " ").slice(0, 280);

export async function buildCatalog(root: string): Promise<CatalogEntry[]> {
  const byKey = new Map<string, CatalogEntry>();
  for (const dir of gameFolders(root)) {
    let raw: any = {};
    try { raw = (await readGameFile(dir)).raw ?? {}; } catch { /* a broken settings file is the doctor's business */ }
    const pf = path.join(dir, "SYSTEM_PROMPT.md");
    const prompt = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : "";
    const launch = launchWords(prompt);
    const desc = String(raw.description || firstParagraph(prompt) || "");
    const key = launch.join("|").toLowerCase() || `dir:${dir}`;
    const flavour = path.relative(root, dir).split(path.sep).slice(1).join("/");
    const e = byKey.get(key);
    if (e) { if (flavour) e.flavours.push(flavour); if (!e.description) e.description = desc; }
    else byKey.set(key, { launch, description: desc, flavours: flavour ? [flavour] : [] });
  }
  return [...byKey.values()].sort((a, b) => (a.launch[0] ?? "~").localeCompare(b.launch[0] ?? "~"));
}

export const asksWhatThisIs = (msg: string): boolean =>
  /^\W*(?:(?:hi|hello|hey)\b\W*)?(?:what(?:'s|s| is| are)?\s+(?:this|you|imeng|going on|is imeng)|what can (?:i|we) (?:do|play|try|ask)|what do you do|who are you|help\b|how (?:does this|do (?:i|you)|can i) (?:work|start|play|begin|use)|what (?:games|apps|imengs|stories)|menu\b|options\b)/i.test(msg.trim());

export function renderCatalog(entries: CatalogEntry[]): string {
  const lines = entries.map((e) => {
    const word = e.launch.length ? e.launch.map((l) => `**${l}**`).join(" or ") : "no launch word: just start talking";
    const fl = e.flavours.length > 1 ? ` (versions: ${e.flavours.join(", ")})` : "";
    return `- ${word}${e.description ? `: ${e.description}` : ""}${fl}`;
  });
  return `This is **imeng**, the *Internet Magic Engine*. It runs interactive stories and games where the rules, dice and bookkeeping live in code and the model only narrates.\n\nStart one by sending its launch words as your first message:\n\n${lines.join("\n")}\n\nAnything else you send is passed straight to the plain chat model.`;
}

let cached: Promise<string> | undefined;
/** The intro text for this server (built once). `root` is the imengs folder. */
export function introText(root: string): Promise<string> { return (cached ??= buildCatalog(root).then(renderCatalog)); }
