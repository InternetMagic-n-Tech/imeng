/**
 * The file bucket (S3-compatible: RustFS in docker-compose, or any S3). Off unless BUCKET_ENDPOINT is set. Files the proxy keeps (pictures it made, files that
 * were uploaded or sent) are copied there, best effort: a bucket that is down never stops a game. Use a bucket of its own (BUCKET_NAME, default proxy-files);
 * MLflow's artifact bucket on the same S3 server is fine but should be a different bucket.
 */
const u = (() => { try { return process.env.BUCKET_ENDPOINT ? new URL(process.env.BUCKET_ENDPOINT) : null; } catch { return null; } })();

export const BUCKET = u ? {
  host: u.hostname,
  port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
  ssl: u.protocol === "https:",
  name: process.env.BUCKET_NAME || "proxy-files",
  accessKey: process.env.BUCKET_ACCESS_KEY || "",
  secretKey: process.env.BUCKET_SECRET_KEY || "",
  region: process.env.BUCKET_REGION || "us-east-1",
} : null;
