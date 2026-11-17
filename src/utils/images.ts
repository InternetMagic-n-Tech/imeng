import { IMAGES, IMAGE_SIZE, IMAGE_JUDGE, OFFER_PREFIX, imageText } from "./image-config.js";
import { scrubForLog } from "./pii-filter.js";
import { loadReference } from "./image-ref.js";
import { saveImage, urlOf, BadImage } from "./image-store.js";
import { screen, UnsafeImage, SafetyUnavailable } from "./image-safety.js";
import { usable } from "./image-format.js";
import { render, realIO } from "./image-adapters.js";
import type { RenderIO } from "./image-adapters.js";
import { imageLease, QueueFull } from "./image-lease.js";
import { ensureRenderer } from "./image-process.js";
import { writePrompt, composePositive } from "./image-prompt.js";
import { refinePrompt, keepRecorded, negativeOf } from "./image-refine.js";
import { judgeJSON } from "./judge.js";
import { untrusted, UNTRUSTED_NOTICE } from "./text.js";
import { contentText } from "./text.js";
import type { Command } from "./commands.js";
import type { Sink } from "./sink.js";
import type { ChatMessage } from "./types.js";
import type { GameState, Session, Visuals } from "./types.js";

/** One picture, start to finish: who it is of, its seed and reference, the prompt, the lease, the renderer, the stored file and the reply text. */

export interface ImageCtx { session: Session; state: GameState; narration: string; io?: RenderIO; random?: () => number; /** The picture is of this actor whatever the writer says (a keepsake). */ forceActor?: string }

const visuals = (s: Session): Visuals => (s.visuals ??= { seeds: {}, refs: {} });
const fill = (key: string, vars: Record<string, string>): string => imageText(key, vars);

/** An actor id from an id, a name, or the start of a name when that is unambiguous. */
export function resolveActor(state: GameState, who: string): string | null {
  const w = who.trim().toLowerCase();
  if (!w) return null;
  const ids = Object.keys(state.actors);
  const exact = ids.find((id) => id.toLowerCase() === w) ?? ids.find((id) => String(state.actors[id]?.name ?? "").toLowerCase() === w);
  if (exact) return exact;
  const part = ids.filter((id) => String(state.actors[id]?.name ?? "").toLowerCase().startsWith(w));
  return part.length === 1 ? part[0] : null;
}

/** The seed an actor is always drawn with: its recorded one, else config.json's, else a random one that is then kept for the session. */
export function seedFor(session: Session, state: GameState, actor: string | undefined, random: () => number = Math.random): number {
  if (!actor) return Math.floor(random() * 2 ** 32);
  const v = visuals(session);
  if (v.seeds[actor] !== undefined) return v.seeds[actor];
  const name = String(state.actors[actor]?.name ?? "");
  const given = IMAGES?.seeds?.[actor] ?? IMAGES?.seeds?.[name];
  v.seeds[actor] = given ?? Math.floor(random() * 2 ** 32);
  return v.seeds[actor];
}

const ASK = `You decide whether a player's message asks for a picture (an image, drawing, photo or portrait) of something in the game. Output ONLY JSON: {"wants": true|false, "subject": "<what the picture is of, in the player's words, max 15 words>"}. A message that merely mentions a picture, or asks a question, is not a request.
${UNTRUSTED_NOTICE}`;

/** The judge notices a natural-language request for a picture and the reply offers one. Returns the reply text, or null when it is not a request. */
export async function maybeOffer(text: string, session: Session): Promise<string | null> {
  const ask = IMAGES?.ask;
  if (!ask) return null;
  if (ask.words?.length) { const t = text.toLowerCase(); if (!ask.words.some((w) => t.includes(w.toLowerCase()))) return null; }
  try {
    const j = await judgeJSON(ASK, `<player_message>${untrusted(text)}</player_message>`, "image_offer", 80, IMAGE_JUDGE);
    const subject = typeof j?.subject === "string" ? j.subject.trim().slice(0, 200) : "";
    if (j?.wants !== true || !subject) return null;
    visuals(session).offer = { kind: "scene", subject };
    return `${OFFER_PREFIX} "${subject}"? ${imageText("offer_confirm")}`;
  } catch (e) { console.warn("picture offer check failed:", (e as Error).message); return null; }
}

/** Handle /draw, /portrait or the yes to an offer; returns the reply (markdown with the picture, or a short message). */
export async function makePicture(cmd: Command, ctx: ImageCtx): Promise<string> {
  const { session, state } = ctx;
  const v = visuals(session);
  let kind: "scene" | "portrait" = "scene", subject = cmd.arg, actor: string | undefined, attached = cmd.attached;
  if (cmd.name === "yes") {
    const o = v.offer;
    if (!o) return fill("failed", {});
    v.offer = undefined;
    ({ kind, subject, actor } = o);
  } else if (cmd.name === "portrait") {
    kind = "portrait";
    const id = resolveActor(state, cmd.arg);
    if (!id) return fill("unknown_who", { who: cmd.arg });
    actor = id;
    subject = String(state.actors[id]?.name ?? id);
  }
  const t0 = Date.now();
  try {
    if (attached && actor) { // a picture sent with /portrait becomes that actor's reference
      const r = await loadReference(attached);
      v.refs[actor] = saveImage(r.bytes);
      attached = undefined;
    }
    if (ctx.forceActor) actor = ctx.forceActor;
    const written = await writePrompt({ kind, subject, narration: ctx.narration, state, actor });
    actor = ctx.forceActor ?? written.actor ?? actor;
    const refined = await refinePrompt(keepRecorded(written.prompt, state, actor));
    const finalPrompt = keepRecorded(refined.prompt, state, actor); // a recorded colour or outfit the judges dropped is added back
    const seed = seedFor(session, state, actor, ctx.random);
    const refSpec = (actor && v.refs[actor]) || IMAGES?.reference?.default;
    const reference = refSpec ? await loadReference(refSpec, { allowUrls: IMAGES?.reference?.urls }) : undefined;
    // nothing personal goes to the renderer
    const job = { positive: scrubForLog(composePositive(finalPrompt)), negative: negativeOf(refined.negative), seed, width: IMAGE_SIZE.width, height: IMAGE_SIZE.height, reference };
    const out = await imageLease()!.run(async () => {
      const t1 = Date.now();
      await ensureRenderer();
      const r = await render(job, IMAGES!, ctx.io ?? realIO);
      console.log(`image rendered in ${Date.now() - t1} ms (${r.kind}, ${r.bytes.length} bytes, seed ${seed})`);
      return r;
    });
    if (!usable(out.kind)) throw new BadImage(out.kind);
    await screen(out.bytes, "render");
    const name = saveImage(out.bytes);
    if (kind === "portrait" && actor && !v.refs[actor]) v.refs[actor] = name; // the first portrait is the reference from then on
    const alt = subject || "picture";
    console.log(`image done in ${Date.now() - t0} ms`);
    return `![${alt.replace(/[\[\]]/g, "")}](${urlOf(name)})\n\n${fill("caption", { subject: alt, who: String(state.actors[actor ?? ""]?.name ?? "") })}`;
  } catch (e) {
    if (e instanceof QueueFull) return fill("queue_full", {});
    if (e instanceof UnsafeImage) { console.warn("picture refused:", e.message); return fill("unsafe", {}); }
    if (e instanceof SafetyUnavailable) { console.warn(e.message); return fill("safety_down", {}); }
    if (e instanceof BadImage) return fill("bad_format", { kind: e.kind === "too_big" ? "too large" : e.kind });
    console.warn("image failed:", (e as Error).message);
    return fill("failed", {});
  }
}

/** A command or a request for a picture, before any round starts. Returns true when it answered (the turn is over). */
export async function imageTurn(cmd: Command | null, text: string, c: { session: Session; messages: ChatMessage[]; sink: Sink }): Promise<boolean> {
  if (!IMAGES) return false;
  const { session } = c;
  if (!cmd && !(IMAGES.ask && session.mode === "game")) return false;
  if (cmd) {
    if (session.mode !== "game") { c.sink.canned(fill("no_game", {})); return true; }
    const narration = contentText(c.messages.filter((m) => m.role === "assistant").at(-1)?.content);
    c.sink.canned(await makePicture(cmd, { session, state: session.snapshots.at(-1)!, narration }));
    return true;
  }
  const offer = await maybeOffer(text, session);
  if (offer === null) return false;
  c.sink.canned(offer);
  return true;
}
