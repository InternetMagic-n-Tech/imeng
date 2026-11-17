#!/usr/bin/env node
// Live driver for a shared-table imeng (Gak Show multiplayer by default): scripted real players against the real server and local models.
// It copies the game to /tmp, starts the proxy on its own port, plays by reading the saved state (not by guessing), prints a short trace and a summary,
// and always cleans up (server by PID, models unloaded, ports checked). One run at a time: it refuses if 3010 or 11435 are in use.
//   node scripts/live-table.mjs [--game imengs/gakshow/multiplayer] [--rounds 4] [--port 3010] [--minutes 30]
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const GAME = path.resolve(flag("game", "imengs/gakshow/multiplayer")), PORT = Number(flag("port", 3010)), ROUNDS = Number(flag("rounds", 4)), FINALE = process.argv.includes("--finale"), NUDGE_AT = Number(flag("nudge-at", 0)), REFUSALS = process.argv.includes("--refusals"), DEADLINE = Date.now() + Number(flag("minutes", 30)) * 60_000;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "live-table-")), SAVES = path.join(T, "saves"), LOG = path.join(T, "server.log"), TRACE = path.join(T, "trace.log");
fs.mkdirSync(SAVES, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => { const l = a.join(" "); console.log(l); fs.appendFileSync(TRACE, l + "\n"); };

const listening = (p) => { try { return execSync(`ss -ltn`, { encoding: "utf8" }).split("\n").some((l) => l.includes(`:${p} `)); } catch { return false; } };
if (listening(PORT) || listening(11435)) { console.error(`port ${PORT} or 11435 is in use: someone else is testing. Not starting.`); process.exit(2); }

const cfgFile = ["config.mjs", "config.json"].map((n) => path.join(GAME, n)).find((f) => fs.existsSync(f));
if (!cfgFile) { console.error(`${GAME} has no config.mjs or config.json`); process.exit(2); }
const cfg = cfgFile.endsWith(".json") ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : await (async () => { const d = (await import(path.resolve(cfgFile))).default; return typeof d === "function" ? d() : d; })();
const MODELS = [process.env.OLLAMA_MODEL || "gemma4:26b", cfg.judge_model].filter(Boolean);
let server = null, cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { checker?.close(); } catch { /* closed */ }
  if (server && !server.killed) { try { process.kill(server.pid, "SIGTERM"); } catch { /* gone */ } }
  for (const m of MODELS) { try { execSync(`ollama stop ${JSON.stringify(m)}`, { stdio: "ignore" }); } catch { /* not loaded */ } }
  say(`cleanup: server stopped, models unloaded, ports ${listening(PORT) || listening(11435) ? "STILL IN USE" : "free"}. Files: ${T}`);
}
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { cleanup(); process.exit(130); });
process.on("exit", cleanup);

// ---- server ----
const gameDir = path.join(T, "game");
fs.cpSync(GAME, gameDir, { recursive: true, filter: (p) => !/node_modules|[\\/](config\.(mjs|ts)|[^\\/]*\.template\.md|HOW_TO_TEST\.md|VISION\.md)$/.test(p) }); // config.mjs imports ../common.mjs, so the copy runs on its settings written as config.json
for (let i = 0; i < argv.length; i++) if (argv[i] === "--set") { const [k, ...rest] = argv[i + 1].split("="); const keys = k.split("."); let o = cfg; for (const key of keys.slice(0, -1)) o = o[key] ??= {}; o[keys.at(-1)] = JSON.parse(rest.join("=")); say(`knob: ${k} = ${rest.join("=")}`); } // --set a.b=<json>: a change in the throwaway copy only
fs.writeFileSync(path.join(gameDir, "config.json"), JSON.stringify(cfg));
// A game with seat pictures (seating.photo) needs a checker: this driver runs a tiny fake one (one person, nose visible), so the whole seat flow is exercised without a pose model.
let checker = null;
const SEATS = !!cfg.seating?.photo;
if (SEATS && !REFUSALS) {
  checker = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ people: [{ score: 0.95, keypoints: Array.from({ length: 17 }, (_, i) => [10, 10, i === 0 ? 0.9 : 0.1]) }] })); }); });
  await new Promise((r) => checker.listen(0, "127.0.0.1", r));
  const live = JSON.parse(fs.readFileSync(path.join(gameDir, "config.json"), "utf8"));
  live.seating.photo.check = { url: `http://127.0.0.1:${checker.address().port}`, threshold: 0.4, keypoint: 0.5, people: 1 };
  if (live.images) delete live.images.safety; // the nudity detector needs its own model file; this run tests the seat flow
  fs.writeFileSync(path.join(gameDir, "config.json"), JSON.stringify(live));
}
server = spawn("node", ["--env-file-if-exists=/dev/null", "dist/server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), IMENG_PATH: gameDir, SAVE_DIR: SAVES, LOG_FILE: path.join(T, "model.jsonl"), MULTIPLAYER_DEBUG: "1", IMAGE_DIR: path.join(T, "images") }, stdio: ["ignore", fs.openSync(LOG, "a"), fs.openSync(LOG, "a")] });
for (let i = 0; i < 90 && !fs.readFileSync(LOG, "utf8").includes("Game proxy on"); i++) await sleep(1000);
if (!fs.readFileSync(LOG, "utf8").includes("Game proxy on")) { say("server did not start; see " + LOG); process.exit(1); }
say(`server up on :${PORT} (${path.basename(GAME)}), files in ${T}`);

// ---- people and chats ----
const PEOPLE = {
  bea: { id: "u-bea", name: "Bea", intro: "Imeng: Gak Show. I'm Bea, 28, a baker from Helsinki, in a yellow raincoat. I have no ground rules." },
  bo: { id: "u-bo", name: "Bo", intro: "I'm Bo, 31, a diver from Oulu, in a denim jacket. I have no ground rules." },
};
const TABLE = "live-table-chat";
const chats = new Map();
async function send(who, text, chat = TABLE, picture = null) {
  const log = chats.get(chat) ?? []; chats.set(chat, log);
  log.push({ role: "user", content: picture ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/png;base64,${picture.toString("base64")}` } }] : text });
  const p = PEOPLE[who];
  const r = await fetch(`http://localhost:${PORT}/v1/chat/completions`, { method: "POST", signal: AbortSignal.timeout(600_000),
    headers: { "content-type": "application/json", "x-openwebui-chat-id": chat, "x-openwebui-user-id": p.id, "x-openwebui-user-name": encodeURIComponent(p.name) },
    body: JSON.stringify({ model: cfg.model_id, messages: log }) });
  const j = await r.json();
  const reply = j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 200);
  log.push({ role: "assistant", content: reply });
  say(`  [${who}] ${text.slice(0, 70)}\n    -> ${reply.replace(/\s+/g, " ").slice(0, 150)}`);
  return reply;
}

// ---- state ----
function readState() {
  let best = null;
  for (const f of fs.readdirSync(SAVES).filter((x) => x.endsWith(".json"))) {
    try { const p = path.join(SAVES, f), d = JSON.parse(fs.readFileSync(p, "utf8")); if (d.snapshots?.length && d.room) { const m = fs.statSync(p).mtimeMs; if (!best || m > best.m) best = { d, m }; } } catch { /* being written */ }
  }
  return best;
}
const view = () => { const b = readState(); if (!b) return null; const s = b.d.snapshots.at(-1), g = s.game, im = g.imeng && typeof g.imeng === "object" ? g.imeng : g; return { d: b.d, s, g, phase: g.phase ?? im.phase, asked: g.asked ?? im.asked, snaps: b.d.snapshots.length, m: b.m }; };
/** Wait until the saved state has stopped changing (the extractor runs after the reply). */
async function settle(max = 150_000) {
  const t0 = Date.now(); let last = "", stable = 0;
  while (Date.now() - t0 < max) {
    await sleep(3000);
    const key = fs.readdirSync(SAVES).filter((x) => x.endsWith(".json")).map((f) => `${f}:${fs.statSync(path.join(SAVES, f)).mtimeMs}`).join("|"); // any save file: a table may not exist yet
    stable = key === last && key ? stable + 1 : 0; last = key;
    if (stable >= 3) return view();
  }
  return view();
}
const seatOf = (v, key) => Object.entries(v.d.room.players).find(([u]) => u === PEOPLE[key].id)?.[1]?.actor;
const out = (v) => ({ phase: v?.phase, asked: v?.asked, snapshots: v?.snaps });

// ---- the script: registration, goals, rounds ----
const failed = (why) => { say("STOPPED: " + why); const v = view(); say("state: " + JSON.stringify(out(v))); process.exit(1); };
const timeUp = () => Date.now() > DEADLINE && failed("time budget used");

say("== registration");
// The table's ready gate: a bare "ready" confirms (^(ready|confirm|done|go)$); any other line is talk and resets the sender's confirmation. So talk first, then a separate "ready".
// While the Host's question is open for one player, the others' "ready" is refused; after two refusals in a row the question is dropped, so repeat it (nothing in between) until it counts.
const ready = async () => {
  await send("bea", "ready");
  for (let i = 0; i < 4; i++) { const r = await send("bo", "ready"); if (!/not the one asked/i.test(r)) break; }
  return settle();
};
await send("bea", PEOPLE.bea.intro); await settle();
if (SEATS && REFUSALS) { // --refusals: the game's real vision module (VISION_VENV, VISION_POSE_WEIGHTS) and image censor; only the refusals are driven, then the run ends
  await send("bea", "/seat 28 female"); const ask = await send("bea", "/seat yes");
  if (!/picture/i.test(ask)) failed(`no picture rules after /seat yes: ${ask.slice(0, 100)}`);
  const blank = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
  say(`  nobody -> ${(await send("bea", "Here is my picture.", TABLE, blank)).slice(0, 160)}`);
  say(`  not an image -> ${(await send("bea", "Here is my picture.", TABLE, Buffer.from("this is not a picture at all"))).slice(0, 160)}`);
  process.exit(0);
}
if (SEATS) { // seats: /seat <age> <gender>, /seat yes (the rules text), a picture (checked), then the owner starts the show
  const png = (n) => sharp({ create: { width: 16 + n, height: 16, channels: 3, background: { r: 90 + n * 20, g: 140, b: 200 } } }).png().toBuffer();
  const sit = async (k, age, gender, n) => {
    await send(k, `/seat ${age} ${gender}`); const ask = await send(k, "/seat yes");
    if (!/picture/i.test(ask)) failed(`no picture rules after /seat yes for ${k}: ${ask.slice(0, 100)}`);
    const ok = await send(k, "Here is my picture.", TABLE, await png(n));
    if (!/accepted/i.test(ok)) failed(`seat picture not accepted for ${k}: ${ok.slice(0, 120)}`);
  };
  await sit("bea", 28, "female", 0);
  await send("bo", PEOPLE.bo.intro); await settle();
  await sit("bo", 31, "male", 1);
  const started = await send("bea", "/start");
  say(`  (start: ${started.slice(0, 80)})`);
  await settle();
}
if (!SEATS) { await send("bo", PEOPLE.bo.intro); await settle(); }
await send("bea", "Add two NPC contestants: Susan, 27, a vet who loves dogs, in a white sundress, and Dex, 33, a chef in a pink apron. Neither has ground rules.");
await send("bo", "The show is set in Helsinki, in winter, in the indoor studio.");
let v = await ready(); // the first narrated round: the extractor creates everyone's actors
for (const k of ["bea", "bo"]) {
  const r = await send(k, k === "bea" ? "/goal get Dex covered in gak" : "/goal stay clean", `${k}-private`);
  if (!/written/i.test(r)) failed(`goal for ${k} not accepted: ${r.slice(0, 100)}`);
}
for (let i = 0; i < 8 && (!v || v.phase === "registration"); i++) {
  timeUp();
  say(`-- registration attempt ${i + 1}`);
  const asked = v?.asked ? ["bea", "bo"].find((k) => seatOf(v, k) === v.asked) : null; // a seated player's intro before the seat was not recorded: answer the Host's open question with it
  if (asked) await send(asked, PEOPLE[asked].intro.replace(/^Imeng: Gak Show\. /, ""));
  else await send(i % 2 ? "bo" : "bea", "We have all written our secret goals on the tablet and nobody has ground rules: please start round 1.");
  v = await ready();
}
if (!v || v.phase === "registration") failed("the show did not leave registration");
say("== playing: phase " + v.phase);

// A round: while the Host has an open question (game.asked) only that player is read, so they answer first, in short plain words (the Host rejects anything
// that grabs the equipment); only when nothing is asked do both confirm with a bare "ready".
const ANSWERS = ["Trivia please.", "Helsinki.", "I will guess: forty two.", "Physical challenge please.", "Yes, I'm ready."];
let stuck = 0, lastSnaps = v.snaps;
const seen = new Set([v.phase]); // every phase the show was seen in, so a run says whether it reached a crossing
for (let r = 1; r <= ROUNDS; r++) {
  timeUp();
  say(`-- round ${r}: phase ${view().phase}`);
  if (NUDGE_AT === r) { const r2 = await send("bea", "Host, that is enough trivia for now: please take everyone across to the gak area for Punishment Time.", "bea"); say(`   asked for a crossing: ${r2.slice(0, 80)}`); } // the producer-only /nudge needs a producer seat the driver does not have
  for (let step = 0; step < 6; step++) {
    v = view();
    const who = v.asked ? ["bea", "bo"].find((k) => seatOf(v, k) === v.asked) : null;
    if (!v.asked || !who) break;
    say(`   asked ${v.asked} (${who})`);
    await send(who, ANSWERS[step % ANSWERS.length]);
    await settle();
  }
  v = await ready();
  seen.add(v.phase);
  if (v.asked) say(`   still asked ${v.asked} after the answers`);
  if (v.snaps === lastSnaps) { if (v.phase === "finale" && ++stuck >= 2) { say("   the show is over: stopping the rounds"); break; } if (++stuck >= 2) failed("two rounds without progress"); } else { stuck = 0; lastSnaps = v.snaps; }
}

// ---- the finale, on request (--finale): the owner ends the show, then two more rounds so the reveal shows ----
if (FINALE) {
  say("== finale: owner /end");
  await send("bea", "/end"); await settle();
  for (let i = 0; i < 3; i++) { timeUp(); await send(i % 2 ? "bo" : "bea", i < 2 ? "ready" : "What happened to everyone's goals?"); v = await settle(); seen.add(v?.phase); }
}

// ---- summary ----
v = view();
const k = v.d.knowledge ?? {}, room = v.d.room ?? {};
say("== summary");
say(JSON.stringify({
  phase: v.phase, phases_seen: [...seen], snapshots: v.snaps,
  npc_traits: Object.fromEntries(Object.entries(v.s.actors).filter(([, a]) => a.controlled_by === "npc").map(([id, a]) => [a.name ?? id, { nosiness: a.nosiness, respects_privacy: a.respects_privacy }])),
  attraction: v.g.attraction ?? null,
  stain: Object.fromEntries(Object.entries(v.s.actors).filter(([id]) => id !== "table").map(([id, a]) => [a.name ?? id, a.stain])),
  knowledge_facts: (k.facts ?? []).map((f) => ({ text: String(f.text).slice(0, 80), knownBy: f.knownBy })),
  overheard: room.overheard ?? [], debrief_queue: room.debrief ?? null,
  announcements: (v.d.announcements ?? []).map((a) => `${a.kind} -> ${a.to ?? "table"}`),
  forfeit: v.g.forfeit ?? null,
}, null, 1));
process.exit(0);
