import { UPSTREAM, MODEL, JUDGE_MODEL, JUDGE_INSTANCE, JUDGE_URL, JUDGE_API } from "./config.js";
import { IMAGES, IMAGE_LEASE, IMAGE_MAX_QUEUE } from "./image-config.js";
import { freeRenderer } from "./image-adapters.js";

/**
 * The GPU lease. One picture is made at a time. While any picture is being made or waiting, the narrator model is unloaded from Ollama
 * (keep_alive 0; the Ollama process is never stopped) and every call that needs it waits at gate(). When the last picture is done the renderer
 * gives its VRAM back and the narrator loads again on its next call. Only models this proxy uses are touched, never other people's.
 */

export class QueueFull extends Error { constructor() { super("image queue is full"); } }

export interface LeaseDeps { unload: () => Promise<void>; free: () => Promise<void>; max: number }

export class Lease {
  private active = 0;
  private held = false;
  private tail: Promise<unknown> = Promise.resolve();
  private waiters: (() => void)[] = [];
  constructor(private deps: LeaseDeps) {}

  get busy(): boolean { return this.active > 0; }
  get waiting(): number { return Math.max(0, this.active - 1); }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active > this.deps.max) throw new QueueFull(); // one running plus `max` waiting
    this.active++;
    const prev = this.tail;
    let done!: () => void;
    this.tail = new Promise<void>((r) => (done = r));
    try {
      await prev;
      if (!this.held) { this.held = true; await this.deps.unload().catch((e: Error) => console.warn("could not unload the narrator:", e.message)); }
      return await fn();
    } finally {
      this.active--;
      done();
      if (this.active === 0) {
        await this.deps.free().catch(() => {});
        this.held = false;
        this.waiters.splice(0).forEach((w) => w());
      }
    }
  }

  /** Resolves at once, or after the picture in progress when the narrator is unloaded. */
  async gate(): Promise<void> {
    while (this.held) await new Promise<void>((r) => this.waiters.push(r));
  }
}

const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: "POST", body: JSON.stringify(body) });

async function unloadOurModels(): Promise<void> {
  const base = UPSTREAM.replace(/\/v1$/, "");
  const models = new Set([MODEL]);
  if (!JUDGE_INSTANCE && !JUDGE_URL && JUDGE_API === "ollama") models.add(JUDGE_MODEL); // a judge on the narrator's Ollama holds VRAM too
  await Promise.all([...models].map((m) => post(`${base}/api/generate`, { model: m, keep_alive: 0 })));
}

let lease: Lease | null = null;
export function imageLease(): Lease | null {
  if (!IMAGES) return null;
  return (lease ??= new Lease({
    unload: IMAGE_LEASE.unloadNarrator ? unloadOurModels : async () => {},
    free: IMAGE_LEASE.freeRenderer ? () => freeRenderer() : async () => {},
    max: IMAGE_MAX_QUEUE,
  }));
}

/** Called before anything that needs the narrator's model. A no-op unless images are on. */
export const gpuGate = (): Promise<void> => (lease ? lease.gate() : Promise.resolve());
