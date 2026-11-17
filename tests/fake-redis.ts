import { jest } from "@jest/globals";

/** A hand-rolled stand-in for node-redis' client, with the members the logger uses. */
export function makeFakeRedis() {
  const fake = {
    isReady: true,
    isOpen: true,
    handlers: {} as Record<string, (e: Error) => void>,
    added: [] as { key: string; fields: Record<string, string>; opts: unknown }[],
    connect: jest.fn(async () => {}),
    quit: jest.fn(async () => { fake.isOpen = false; }),
    on(event: string, cb: (e: Error) => void) { fake.handlers[event] = cb; return fake; },
    xAdd: jest.fn(async (key: string, _id: string, fields: Record<string, string>, opts: unknown) => {
      fake.added.push({ key, fields, opts });
      return `${1000 + fake.added.length}-0`;
    }),
    xDel: jest.fn(async (_key: string, _ids: string[]) => 1),
  };
  return fake;
}
