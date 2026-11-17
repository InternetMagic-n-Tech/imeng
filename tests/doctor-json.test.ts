import { describe, it, expect } from "@jest/globals";
import { placeholderJson } from "../src/utils/doctor.js";

describe("doctor: placeholder JSON in prompts", () => {
  it("flags placeholders a small model would copy", () => {
    expect(placeholderJson('Reply {"ops": [...]} like {"path": "<path>", "value": "..."}')).toEqual(expect.arrayContaining(['"<path>"']));
    expect(placeholderJson('```json\n{"name": "string", "hp": number}\n```')).toContain('"string"');
    expect(placeholderJson('Output {"verdict": "blah-blah-blah"}')).toEqual(['"blah-blah-blah"']);
  });
  it("accepts a real example and ordinary prose", () => {
    expect(placeholderJson('Reply {"op":"set","path":"actors.user.hp","value":12}')).toEqual([]);
    expect(placeholderJson("Use <private> tags and say ... when unsure")).toEqual([]);
  });
});
