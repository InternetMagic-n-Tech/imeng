import { PRODUCTION, REDIS_URL, PROXY_API_KEY, SESSION_STORE } from "./config.js";

/** What a production start should tell the operator (warnings, never failures): what it assumes and what is missing for several servers. */
export function productionNotes(): string[] {
  if (!PRODUCTION) return [];
  const notes: string[] = [];
  if (!REDIS_URL) notes.push("production: REDIS_URL is not set, so sessions are kept in files and only one proxy server is safe; set it to share sessions across servers");
  else if (SESSION_STORE === "file") notes.push("production: SESSION_STORE=file ignores Redis for sessions (one server only)");
  if (!PROXY_API_KEY) notes.push("production: PROXY_API_KEY is not set, so /v1 is open to anyone who can reach the proxy");
  notes.push("production: the narrator (UPSTREAM) and the judge (JUDGE_URL) are expected to be running; nothing is started by this process");
  return notes;
}
