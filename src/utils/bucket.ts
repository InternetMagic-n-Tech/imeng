import { Client } from "minio";
import { BUCKET } from "./bucket-config.js";
import { dbg } from "./debug.js";

const log = dbg("bucket");

/** The slice of the MinIO client used here, so a test can pass a fake. */
export interface BucketClient {
  bucketExists(name: string): Promise<boolean>;
  makeBucket(name: string, region?: string): Promise<void>;
  putObject(bucket: string, key: string, data: Buffer, size: number, meta?: Record<string, string>): Promise<unknown>;
  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;
  removeObject?(bucket: string, key: string): Promise<void>;
  fPutObject?(bucket: string, key: string, file: string, meta?: Record<string, string>): Promise<unknown>;
}

let client: BucketClient | null = BUCKET ? (new Client({ endPoint: BUCKET.host, port: BUCKET.port, useSSL: BUCKET.ssl, accessKey: BUCKET.accessKey, secretKey: BUCKET.secretKey, region: BUCKET.region }) as unknown as BucketClient) : null;
let name = BUCKET?.name ?? "";
let ready = false;

/** Test hook. */
export function _useClient(c: BucketClient | null, bucket = "proxy-files"): void { client = c; name = bucket; ready = false; }

export const bucketOn = (): boolean => !!client;

/** Create the bucket when it is missing. Returns false (and says why) when the bucket cannot be used; never throws. */
export async function bucketReady(): Promise<boolean> {
  if (!client) return false;
  if (ready) return true;
  try {
    if (!(await client.bucketExists(name))) { await client.makeBucket(name, BUCKET?.region); log("created bucket %s", name); }
    ready = true;
    return true;
  } catch (e) { console.warn(`bucket ${name} is not usable: ${(e as Error).message}`); log("not usable: %s", (e as Error).message); return false; }
}

/** Keep a file. Best effort: a failure is logged and the game goes on. Returns whether it was stored. */
export async function bucketPut(key: string, bytes: Uint8Array, type = "application/octet-stream"): Promise<boolean> {
  if (!client || !(await bucketReady())) return false;
  try { await client.putObject(name, key, Buffer.from(bytes), bytes.length, { "Content-Type": type }); log("put %s (%d bytes)", key, bytes.length); return true; }
  catch (e) { console.warn(`bucket put ${key} failed: ${(e as Error).message}`); log("put %s FAILED: %s", key, (e as Error).message); return false; }
}

/** A stored file's bytes, or null when it is not there or the bucket is down. */
export async function bucketGet(key: string): Promise<Buffer | null> {
  if (!client || !(await bucketReady())) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const c of await client.getObject(name, key)) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  } catch (e) { log("get %s: %s", key, (e as Error).message); return null; }
}

/** Pipe a staged file into the bucket without holding it in memory. Best effort; true when the bucket has it. */
export async function bucketPutFile(key: string, file: string, type = "application/octet-stream"): Promise<boolean> {
  if (!client || !(await bucketReady())) return false;
  try {
    if (client.fPutObject) await client.fPutObject(name, key, file, { "Content-Type": type });
    else { const { default: fs } = await import("node:fs"); const size = fs.statSync(file).size; await client.putObject(name, key, fs.readFileSync(file), size, { "Content-Type": type }); }
    log("put file %s -> %s", file, key);
    return true;
  } catch (e) { console.warn(`bucket put ${key} failed: ${(e as Error).message}`); log("put %s FAILED: %s", key, (e as Error).message); return false; }
}

/** Delete one object. True when it is gone (or never was); false when the bucket is off, cannot delete, or failed. Never throws. */
export async function bucketRemove(key: string): Promise<boolean> {
  if (!client || typeof client.removeObject !== "function") return false;
  try { await client.removeObject(name, key); return true; } catch (e) { console.warn(`bucket: could not delete ${key}: ${(e as Error).message}`); return false; }
}
