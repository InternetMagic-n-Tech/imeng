// A stand-in for src/tools/vision/worker.py: the same JSON lines. The picture's bytes pick the behaviour: "slow" never answers, "exit" exits, "error" answers an error.
import fs from "node:fs";
import readline from "node:readline";
if (process.env.VISION_PIDFILE) fs.appendFileSync(process.env.VISION_PIDFILE, process.pid + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line), what = Buffer.from(m.image ?? "", "base64").toString();
  if (what === "slow") return;
  if (what === "exit") process.exit(3);
  if (what === "error") return void console.log(JSON.stringify({ id: m.id, ok: false, error: "model exploded" }));
  const out = m.op === "pose" ? { people: [{ score: 0.9, keypoints: Array.from({ length: 17 }, (_, i) => [i, i * 2, i === 0 ? 0.9 : 0.1]) }] } : m.op === "censor" ? { hits: [{ label: "FACE_FEMALE", score: 0.8 }] } : {};
  console.log(JSON.stringify({ id: m.id, ok: true, ...out }));
});
