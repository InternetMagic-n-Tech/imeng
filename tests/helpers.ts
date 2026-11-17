import { jest } from "@jest/globals";

/** A Response with a JSON body. */
export const jsonResponse = (data: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** A text/event-stream Response sending the given raw chunks. */
export function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** SSE chunks streaming `text` (one word per chunk), optionally with a thinking field first. */
export function sseChunks(text: string, withReasoning = true): string[] {
  const out: string[] = [];
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  out.push(chunk({ role: "assistant", content: "" }));
  if (withReasoning) { out.push(chunk({ content: "", reasoning: "hmm" })); out.push(chunk({ content: "", reasoning: "ok" })); }
  for (const w of text.split(/(?<= )/)) out.push(chunk({ content: w }));
  out.push(chunk({}, "stop"));
  out.push("data: [DONE]\n\n");
  return out;
}

/** A minimal stand-in for an Express response that records what was written. */
export function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    written: [] as string[],
    body: undefined as unknown,
    sent: undefined as unknown,
    ended: false,
    headersSent: false,
    status(c: number) { res.statusCode = c; return res; },
    set(k: string, v: string) { res.headers[k] = v; return res; },
    write(s: string) { res.written.push(s); res.headersSent = true; return true; },
    end() { res.ended = true; return res; },
    json(b: unknown) { res.body = b; res.headersSent = true; return res; },
    send(b: unknown) { res.sent = b; res.headersSent = true; return res; },
  };
  return res;
}

export type ScriptedFetch = jest.Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

/** Replace global fetch with a mock; returns it so tests can inspect calls. */
export function mockFetch(impl: (url: string, body: any) => Response | Promise<Response>): ScriptedFetch {
  const fn = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return impl(String(input), body);
  }) as ScriptedFetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
