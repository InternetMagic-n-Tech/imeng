import type { Request, Response } from "express";

/**
 * Ollama-shaped answers for a client whose "Ollama connection" points at this proxy (GET /api/tags, /api/version, /api/ps, POST /api/show, /api/chat).
 * The game is the only model. /api/chat runs the same turn as /v1/chat/completions; `ollamaFacade` turns the OpenAI-shaped answer (JSON or SSE) into Ollama's
 * (one JSON object, or newline-delimited JSON with `done`).
 */
export const OLLAMA_VERSION = "0.9.0";

export const tagsBody = (model: string) => ({ models: [{ name: model, model, modified_at: new Date(0).toISOString(), size: 0, digest: "", details: { format: "", family: "", families: null, parameter_size: "", quantization_level: "" } }] });
export const showBody = (model: string) => ({ modelfile: "", parameters: "", template: "", details: tagsBody(model).models[0].details, model_info: {}, capabilities: ["completion"] });

type Out = Pick<Response, "status" | "set" | "json" | "send" | "write" | "end" | "headersSent">;

/** Wraps the real response so code that writes OpenAI JSON or SSE answers in Ollama's format. */
export function ollamaFacade(real: Response, model: string, stream: boolean): Out {
  const stamp = () => new Date().toISOString();
  let buf = "", finished = false, wrote = false;
  const line = (o: object): void => { wrote = true; real.write(JSON.stringify(o) + "\n"); };
  const last = (): void => { if (finished) return; finished = true; line({ model, created_at: stamp(), message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }); };
  const one = (j: any): object => j?.error ? j : { model, created_at: stamp(), message: { role: "assistant", content: String(j?.choices?.[0]?.message?.content ?? "") }, done: true, done_reason: "stop" };
  const feed = (l: string): void => {
    if (!l.startsWith("data:")) return;
    if (l.includes("[DONE]")) { last(); return; }
    let j: any; try { j = JSON.parse(l.slice(5)); } catch { return; }
    const text = j?.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) line({ model, created_at: stamp(), message: { role: "assistant", content: text }, done: false });
    if (j?.choices?.[0]?.finish_reason) last();
  };
  const f: Out = {
    get headersSent() { return real.headersSent; },
    status(c: number) { real.status(c); return f as unknown as Response; },
    set(name: any, value?: any) { if (typeof name === "string" && name.toLowerCase() === "content-type") real.set("Content-Type", stream ? "application/x-ndjson" : "application/json"); else real.set(name, value); return f as unknown as Response; },
    json(o: any) { real.json(one(o)); return f as unknown as Response; },
    send(b: any) { let j: any; try { j = JSON.parse(Buffer.isBuffer(b) ? b.toString("utf8") : String(b)); } catch { real.send(b); return f as unknown as Response; } real.json(one(j)); return f as unknown as Response; },
    write(c: any) { buf += Buffer.isBuffer(c) ? c.toString("utf8") : String(c); let i; while ((i = buf.indexOf("\n")) >= 0) { feed(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } return true; },
    end() { if (buf.trim()) feed(buf.trim()); buf = ""; if (stream && wrote) last(); real.end(); return f as unknown as Response; },
  } as Out;
  return f;
}

/** The request as /v1/chat/completions reads it: Ollama streams unless `stream` is false. */
export const asOpenAI = (req: Request): boolean => { const stream = req.body?.stream !== false; req.body = { ...req.body, stream }; return stream; };
