/** The bridge's client of the proxy: an OpenAI-compatible chat request, answered as a stream of text deltas. */

export class ProxyError extends Error { constructor(message: string, readonly status?: number) { super(message); } }

export interface AskOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: { role: string; content: string | unknown[] }[];
  /** The conversation's id (the proxy's session key). */
  chatId: string;
  user: { id: string; name: string };
  /** Background for this turn (X-Game-Context). */
  context?: string;
  onDelta(text: string): void | Promise<void>;
  /** The proxy asked for this person to be removed from the channel until then (x-imeng-kick: <user id>;<until ms>). */
  onKick?(userId: string, until: number): void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

/** The text of one `data:` event of an OpenAI stream (null for the end or an event with no text). Throws on an error event. */
export function deltaOf(data: string): string | null {
  if (data === "[DONE]") return null;
  let j: any;
  try { j = JSON.parse(data); } catch { return null; }
  if (j?.error) throw new ProxyError(String(j.error.message ?? j.error));
  const c = j?.choices?.[0]?.delta?.content;
  return typeof c === "string" ? c : null;
}

/** Ask the proxy and pass each piece of the answer to `onDelta` as it arrives. Resolves with the whole answer. */
export async function askProxy(o: AskOptions): Promise<string> {
  const f = o.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-openwebui-chat-id": o.chatId,
    "x-openwebui-user-id": `discord:${o.user.id}`,
    "x-openwebui-user-name": encodeURIComponent(o.user.name),
  };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  if (o.context) headers["x-game-context"] = encodeURIComponent(o.context.slice(0, 2000));
  let res: Response;
  try { res = await f(`${o.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: o.model, stream: true, messages: o.messages }), signal: o.signal }); }
  catch (e) { throw new ProxyError(`could not reach the proxy: ${(e as Error).message}`); }
  const kick = /^discord:(\d+);(\d+)$/.exec(res.headers.get("x-imeng-kick") ?? "");
  if (kick) o.onKick?.(kick[1]!, Number(kick[2]));
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("application/json")) { // an error, or an answer that was not streamed
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProxyError(String(body?.error?.message ?? `the proxy answered HTTP ${res.status}`), res.status);
    const text = String(body?.choices?.[0]?.message?.content ?? "");
    await o.onDelta(text);
    return text;
  }
  if (!res.body) throw new ProxyError("the proxy sent no body");
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", all = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const piece = deltaOf(line.slice(5).trim());
        if (piece) { all += piece; await o.onDelta(piece); }
      }
    }
  }
  return all;
}
