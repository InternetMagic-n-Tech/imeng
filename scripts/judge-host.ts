import "../src/utils/env-boot.js";
import { execFileSync } from "node:child_process";
import { JUDGE_INSTANCE, JUDGE_MODEL } from "../src/utils/config.js";
import { startJudgeInstance } from "../src/utils/judge.js";

/**
 * Host-side launcher for the judge's Ollama, for when the proxy itself runs in Docker.
 *
 * Containers can't (and shouldn't) run Ollama, so this runs it on the host and listens on the Docker
 * bridge address only: reachable from containers as host.docker.internal, but not from your LAN.
 * Override the address with JUDGE_BIND (e.g. 127.0.0.1, or 0.0.0.0 to listen everywhere).
 */
function dockerBridgeIp(): string | null {
  try {
    const out = execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || null;
  } catch { return null; }
}

if (!JUDGE_INSTANCE) {
  console.error('No "judge_instance" in config.json (or JUDGE_INSTANCE=off): nothing to start.');
  process.exit(1);
}

const host = process.env.JUDGE_BIND || dockerBridgeIp() || "127.0.0.1";
const result = await startJudgeInstance({ host });
if (!result) process.exit(1);

console.log(`Judge model "${JUDGE_MODEL}" is served at ${result.base}`);
console.log(`In Docker: JUDGE_URL=http://host.docker.internal:${new URL(result.base).port} (compose default).`);
if (!result.spawned) {
  console.log("It was already running, so there is nothing more to do here.");
  process.exit(0);
}
console.log("Leave this running; Ctrl-C stops it.");
setInterval(() => {}, 1 << 30); // keep the process (and its Ollama child) alive
