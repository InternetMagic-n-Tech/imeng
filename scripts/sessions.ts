import "../src/utils/env-boot.js";
import { startRedis, redisClient } from "../src/utils/logger.js";
import { SESSION_PREFIX, REDIS_URL } from "../src/utils/config.js";
import { exportSessions, importSessions, clearSessions, listSessions } from "../src/utils/sessions-cli.js";

/** `npm run sessions -- <list|export|import|clear> [dir] [--game <model_id>]`: see utils/sessions-cli.ts. */
const args = process.argv.slice(2);
const gi = args.indexOf("--game");
const game = gi >= 0 ? args.splice(gi, 2)[1] : "";
const [cmd, dir] = args;
const prefix = game ? `game:${game}` : SESSION_PREFIX;

const usage = `Usage: npm run sessions -- <command> [--game <model_id>]
  list              the sessions in Redis
  export <dir>      write them to <dir> as readable JSON (the same files file mode keeps in SAVE_DIR)
  import <dir>      load the JSON files in <dir> into Redis (replaces a session with the same key)
  clear             remove every session of the game from Redis
Needs REDIS_URL. The game is this one's model_id (or --game); keys start with "${prefix}".`;

if (!cmd || !["list", "export", "import", "clear"].includes(cmd) || (["export", "import"].includes(cmd) && !dir)) { console.log(usage); process.exit(cmd ? 1 : 0); }
if (!REDIS_URL) { console.error("REDIS_URL is not set."); process.exit(1); }
await startRedis();
if (!redisClient()?.isReady) { console.error("Could not connect to Redis."); process.exit(1); }
if (cmd === "list") { for (const s of await listSessions(prefix)) console.log(`${s.key}  v${s.version}  ${s.turns} turn(s)${s.mode ? "  " + s.mode : ""}`); }
if (cmd === "export") console.log(`exported ${await exportSessions(dir!, prefix)} session(s) to ${dir}`);
if (cmd === "import") console.log(`imported ${await importSessions(dir!, prefix)} session(s) from ${dir}`);
if (cmd === "clear") console.log(`removed ${await clearSessions(prefix)} key(s) under ${prefix}`);
process.exit(0);
