import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { jsonResponse } from "./helpers.js";

export const PNG = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/images/ref.png"));

/** A scripted ComfyUI. Installed in front of whatever global fetch is now (the fake Ollama), so only the renderer's addresses are answered here. */
export function makeRenderer(base = "http://127.0.0.1:8188") {
  const s = {
    calls: [] as { path: string; body?: any }[],
    output: PNG as Buffer,
    nodeErrors: undefined as unknown,
    pendingPolls: 0,           // how many /history answers say "not yet"
    status: 200,
    delayMs: 0,
    uploads: 0,
  };
  const prev = globalThis.fetch;
  const fn = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(base)) return prev(input, init);
    const p = url.slice(base.length);
    let body: any;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    s.calls.push({ path: p, body });
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.status !== 200) return new Response("no", { status: s.status });
    if (p === "/" ) return new Response("ok");
    if (p === "/upload/image") { s.uploads++; return jsonResponse({ name: "ref-1.png" }); }
    if (p === "/prompt") return jsonResponse({ prompt_id: "p1", node_errors: s.nodeErrors ?? {} });
    if (p.startsWith("/history/")) return jsonResponse(s.pendingPolls-- > 0 ? {} : { p1: { outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } });
    if (p.startsWith("/view?")) return new Response(new Uint8Array(s.output), { status: 200 });
    if (p === "/free") return jsonResponse({});
    return new Response("?", { status: 404 });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { s, fn, paths: () => s.calls.map((c) => c.path.split("?")[0]) };
}
