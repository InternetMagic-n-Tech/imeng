#!/usr/bin/env node
// Sends one picture through the vision worker and prints what both checks say, with the engine's own rules applied.
// Run it once after setting up the venv (src/tools/vision/README.md). Usage: node scripts/vision-check.mjs <picture> [path/to/imeng-folder]
// Needs the folder's config.json to have a `vision` block (default: imengs/backrooms). Uses the same code the proxy uses (via vite-node).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [pic, game = "imengs/backrooms"] = process.argv.slice(2);
if (!pic || !fs.existsSync(pic)) { console.error("Usage: node scripts/vision-check.mjs <picture> [imeng folder]"); process.exit(2); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = path.join(os.tmpdir(), `vision-check-${process.pid}.ts`);
fs.writeFileSync(tmp, `
import fs from "node:fs";
import { judgePose } from ${JSON.stringify(path.join(root, "src/utils/seat-photo.ts"))};
import { SEATING } from ${JSON.stringify(path.join(root, "src/utils/config.ts"))};
import { visionPose, visionCensor, stopVision } from ${JSON.stringify(path.join(root, "src/utils/vision.ts"))};
const bytes = fs.readFileSync(${JSON.stringify(path.resolve(pic))});
const log = console.log; console.log = () => {};
try {
  const people = await visionPose(bytes);
  log("pose: " + people.length + " person(s); " + people.map((p) => "score " + p.score.toFixed(2) + ", nose " + (p.keypoints[0]?.c ?? 0).toFixed(2)).join("; "));
  log("rule: " + JSON.stringify(judgePose(people, { threshold: SEATING?.photo?.check.threshold ?? 0.4, keypoint: SEATING?.photo?.check.keypoint ?? 0.5, people: SEATING?.photo?.check.people ?? 1, eyes: SEATING?.photo?.check.eyes ?? 0, faceMin: SEATING?.photo?.check.faceMin ?? 0, faceScore: Math.max(0, ...(await visionCensor(bytes)).filter((h) => h.label.startsWith("FACE_")).map((h) => h.score)) })));
  log("censor: " + JSON.stringify((await visionCensor(bytes)).filter((h) => h.score >= 0.3)));
} catch (e) { log("FAILED: " + (e as Error).message); process.exitCode = 1; } finally { stopVision(); }
`);
const r = spawnSync("node", [path.join(root, "node_modules/vite-node/dist/cli.mjs"), tmp], { cwd: root, stdio: "inherit", env: { ...process.env, IMENG_PATH: path.resolve(game) } });
fs.rmSync(tmp, { force: true });
process.exit(r.status ?? 1);
