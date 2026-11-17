// Runs before every test file: point the app at fixtures and throwaway directories.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imeng-test-"));
process.env.NODE_ENV = "test";
process.env.IMENG_PATH = path.join(process.cwd(), "tests/fixtures/game");
process.env.SAVE_DIR = path.join(tmp, "saves");
process.env.LOG_FILE = path.join(tmp, "logs", "model-responses.jsonl");
process.env.TEST_TMP = tmp;
for (const k of ["REDIS_URL", "JUDGE_MODEL", "JUDGE_INSTANCE", "OLLAMA_MODEL", "UPSTREAM", "LOG_STREAM", "LOG_MAXLEN", "LOG_PROMPT_CHARS"]) delete process.env[k];
