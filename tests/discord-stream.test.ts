import { describe, it, expect } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { splitForDiscord, DiscordReply, DISCORD_MAX } from "../src/modules/discord/bridge/stream.js";
import { askProxy, deltaOf, ProxyError } from "../src/modules/discord/bridge/proxy.js";
import { FakeDiscord } from "./fake-discord.js";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("splitForDiscord", () => {
  it("leaves a short text alone and trims trailing space", () => {
    expect(splitForDiscord("hello world\n\n")).toEqual(["hello world"]);
    expect(splitForDiscord("")).toEqual([""]);
  });

  it("cuts a long text at a paragraph when it can, then a line, then a word, never over the limit, and loses nothing", () => {
    const text = [words(60), words(60), words(60)].join("\n\n");
    const parts = splitForDiscord(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join(" ").split(/\s+/).join(" ")).toBe(text.split(/\s+/).join(" "));
    expect(parts[0].endsWith("word59")).toBe(true); // cut at the paragraph break, not in the middle of a paragraph
    const noBreaks = "x".repeat(2500);
    expect(splitForDiscord(noBreaks, 1000).map((p) => p.length)).toEqual([1000, 1000, 500]); // no break to use: a hard cut
    expect(splitForDiscord(noBreaks).every((p) => p.length <= 2000)).toBe(true);
  });

  it("closes a code block that is cut and reopens it in the next message, keeping the language", () => {
    const code = "```ts\n" + Array.from({ length: 120 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n```\nDone.";
    const parts = splitForDiscord(code, 600);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts.slice(0, -1)) { expect(p.endsWith("```")).toBe(true); expect((p.match(/```/g) ?? []).length % 2).toBe(0); }
    expect(parts[1].startsWith("```ts\n")).toBe(true);
    expect(parts.at(-1)!.endsWith("Done.")).toBe(true);
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
  });

  it("is prefix-stable: as text grows, the messages already finished do not change", () => {
    const text = words(900);
    const finalParts = splitForDiscord(text, 800);
    for (let cut = 100; cut < text.length; cut += 337) {
      const so = splitForDiscord(text.slice(0, cut), 800);
      for (let i = 0; i < so.length - 1; i++) expect(so[i]).toBe(finalParts[i]);
    }
  });
});

describe("DiscordReply", () => {
  const setup = (opts: object = {}) => {
    const d = new FakeDiscord(); let t = 0;
    const clock = { now: () => t };
    const reply = new DiscordReply(d.api, "c1", "77", { minEditMs: 1000, clock, ...opts });
    return { d, reply, advance: (ms: number) => { t += ms; } };
  };

  it("sends at the first words, edits at most once per interval, and the end writes the exact text", async () => {
    const { d, reply, advance } = setup();
    await reply.push("Hello");
    expect(d.botMessages("c1").map((m) => m.content)).toEqual(["Hello"]);
    await reply.push(" there"); await reply.push(" friend"); // too soon: no edit
    expect(reply.edits).toBe(0);
    advance(1200);
    await reply.push(", how are you?");
    expect(reply.edits).toBe(1);
    expect(d.botMessages("c1")[0].content).toBe("Hello there friend, how are you?");
    await reply.push(" Fine."); // too soon again
    expect(d.botMessages("c1")[0].content).toBe("Hello there friend, how are you?");
    expect(await reply.finish()).toBe("Hello there friend, how are you? Fine.");
    expect(d.botMessages("c1")[0].content).toBe("Hello there friend, how are you? Fine.");
    expect(reply.messages).toBe(1);
  });

  it("every message replies to the player's message, and an answer longer than one message becomes several", async () => {
    const { d, reply, advance } = setup({ max: 500 });
    for (const w of words(400).split(" ")) { await reply.push(w + " "); advance(50); }
    const full = await reply.finish();
    const msgs = d.botMessages("c1");
    expect(msgs.length).toBeGreaterThan(2);
    expect(msgs.every((m) => m.replyToId === "77" && m.content.length <= 500)).toBe(true);
    expect(msgs.map((m) => m.content).join(" ").split(/\s+/).join(" ")).toBe(full.trim().split(/\s+/).join(" "));
    expect(reply.messages).toBe(msgs.length);
  });

  it("never sends an empty message: nothing at all becomes a short notice, and whitespace is not sent", async () => {
    const a = setup(); await a.reply.push("   "); expect(a.d.botMessages("c1")).toHaveLength(0); // blank is not sent
    await a.reply.push("hi"); expect(a.d.botMessages("c1").map((m) => m.content)).toEqual(["hi"]);
    const b = setup(); await b.reply.finish();
    expect(b.d.botMessages("c1").map((m) => m.content)).toEqual(["(the game had nothing to say)"]);
  });

  it("a Discord failure surfaces to the caller", async () => {
    const { d, reply } = setup(); d.failSend = true;
    await expect(reply.push("hello")).rejects.toThrow("Discord is down");
  });

  it("the default limit leaves room under Discord's 2000", () => { expect(DISCORD_MAX).toBeLessThan(2000); });
});

describe("the proxy client", () => {
  let server: http.Server, port: number, seen: { headers: http.IncomingHttpHeaders; body: any }[] = [], mode = "stream";
  const start = async () => {
    server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        seen.push({ headers: req.headers, body: JSON.parse(b) });
        if (mode === "error") { res.statusCode = 502; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: { message: "this game is busy" } })); return; }
        if (mode === "json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "a whole answer" } }] })); return; }
        res.setHeader("content-type", "text/event-stream");
        const ev = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
        const wire = ev("Hel") + ev("lo ") + `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n` + ev("world") + "data: [DONE]\n\n";
        res.write(wire.slice(0, 30)); setTimeout(() => { res.write(wire.slice(30, 90)); setTimeout(() => res.end(wire.slice(90)), 20); }, 20); // events cut at arbitrary places
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));
  const ask = (extra: object = {}) => { const deltas: string[] = []; const p = askProxy({ baseUrl: `http://127.0.0.1:${port}/`, apiKey: "KEY", model: "m", messages: [{ role: "user", content: "hi" }], chatId: "discord:desk:c1:111", user: { id: "111", name: "Zoë Ng" }, onDelta: (d) => { deltas.push(d); }, ...extra }); return { p, deltas }; };

  it("sends an OpenAI request with the identity headers and passes the streamed text on, whatever way the events were cut", async () => {
    mode = "stream"; seen = []; await start();
    const { p, deltas } = ask({ context: "Bot settings: {\"symbol\":\"AAPL\"}\nBo said \"x\"" });
    expect(await p).toBe("Hello world");
    expect(deltas).toEqual(["Hel", "lo ", "world"]);
    const { headers, body } = seen[0];
    expect(body).toEqual({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(headers).toMatchObject({ authorization: "Bearer KEY", "x-openwebui-chat-id": "discord:desk:c1:111", "x-openwebui-user-id": "discord:111", "x-openwebui-user-name": encodeURIComponent("Zoë Ng") });
    expect(decodeURIComponent(String(headers["x-game-context"]))).toBe("Bot settings: {\"symbol\":\"AAPL\"}\nBo said \"x\"");
    await stop();
  });

  it("an error answer becomes a ProxyError with the proxy's message and status; a non-streamed answer still arrives", async () => {
    mode = "error"; seen = []; await start();
    await expect(ask().p).rejects.toMatchObject({ message: "this game is busy", status: 502 });
    await stop();
    mode = "json"; await start();
    const { p, deltas } = ask();
    expect(await p).toBe("a whole answer");
    expect(deltas).toEqual(["a whole answer"]);
    await stop();
  });

  it("an unreachable proxy is a ProxyError, and no key means no authorization header", async () => {
    await expect(askProxy({ baseUrl: "http://127.0.0.1:1", model: "m", messages: [], chatId: "c", user: { id: "1", name: "A" }, onDelta: () => {} })).rejects.toBeInstanceOf(ProxyError);
    mode = "stream"; seen = []; await start();
    await ask({ apiKey: undefined }).p;
    expect(seen[0].headers.authorization).toBeUndefined();
    await stop();
  });

  it("deltaOf: text of a content event, nothing for the end or a role-only event, an error event throws", () => {
    expect(deltaOf(JSON.stringify({ choices: [{ delta: { content: "x" } }] }))).toBe("x");
    expect(deltaOf("[DONE]")).toBeNull();
    expect(deltaOf(JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }))).toBeNull();
    expect(deltaOf("not json")).toBeNull();
    expect(() => deltaOf(JSON.stringify({ error: { message: "boom" } }))).toThrow("boom");
  });
});
