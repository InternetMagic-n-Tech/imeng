import request from "supertest";
import type { Express } from "express";

export type Who = { id: string; name: string } | null;

/** One Open WebUI chat: every request carries the whole chat so far, and each reply is saved into it, as Open WebUI does. */
export const makeChat = (app: Express, id: string) => {
  const log: { role: string; content: string }[] = [];
  return {
    log,
    send: async (who: Who, text: string) => {
      log.push({ role: "user", content: text });
      const r = request(app).post("/v1/chat/completions").set("x-openwebui-chat-id", id);
      if (who) r.set("x-openwebui-user-id", who.id).set("x-openwebui-user-name", encodeURIComponent(who.name));
      const res = await r.send({ messages: log });
      const content = res.body?.choices?.[0]?.message?.content;
      if (typeof content === "string") log.push({ role: "assistant", content });
      return content as string;
    },
  };
};
