import { describe, it, expect } from "@jest/globals";
import { parseTokens } from "../src/utils/pii-store.js";

describe("pii token store", () => {
  it("keeps only salted-hash tokens: kind and hash, never a value, never a fixed placeholder", () => {
    expect(parseTokens(["[uncle:3fa9c2]", "[sensitive:aa11bb22]", "[SECRET]", "[PIN]", "[uncle:3fa9c2]", "plain text", "[brother+multiple:0a0b0c]"]))
      .toEqual([{ kind: "uncle", hash: "3fa9c2" }, { kind: "sensitive", hash: "aa11bb22" }, { kind: "brother+multiple", hash: "0a0b0c" }]);
  });
});
