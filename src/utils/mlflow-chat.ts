import { MLFLOW_URI, MLFLOW_TOKEN, MLFLOW_PER_CHAT, MLFLOW_TIMEOUT_MS } from "./config.js";
import { experimentName, getOrCreateExperiment } from "./mlflow-admin.js";
import type { Admin } from "./mlflow-admin.js";

/* With MLFLOW_EXPERIMENT_PER_CHAT every chat session is its own experiment: <model>-<local time>-T-<zone>-<session>, created when it does not exist, kept for the life of the process. */

const ids = new Map<string, Promise<string | null>>();
let warned = false;

export function chatExperimentId(session: string, model: string, admin: Admin = { uri: MLFLOW_URI, token: MLFLOW_TOKEN, timeoutMs: MLFLOW_TIMEOUT_MS }, on = MLFLOW_PER_CHAT): Promise<string | null> {
  if (!on || !session) return Promise.resolve(null);
  let p = ids.get(session);
  if (!p) {
    const t0 = Date.now();
    p = getOrCreateExperiment(admin, experimentName({ model, session })).then((id) => { console.log(`[mlflow] experiment ${id} for ${session} in ${Date.now() - t0}ms`); return id; }, (e) => {
      if (!warned) { warned = true; console.warn("mlflow per-chat experiment failed:", (e as Error).message); }
      ids.delete(session);
      return null;
    });
    ids.set(session, p);
  }
  return p;
}
export function _resetChatExperiments(): void { ids.clear(); warned = false; }
