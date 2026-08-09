import { describe, expect, it } from "vitest";
import { tokenizeCode } from "./code-tokenizer.js";

describe("code tokenizer", () => {
  it("maps source tokens to OMP's semantic syntax categories", () => {
    expect(tokenizeCode('const answer: Result = run("42"); // ready', "ts")).toEqual(
      expect.arrayContaining([
        { kind: "keyword", text: "const" },
        { kind: "variable", text: "answer" },
        { kind: "type", text: "Result" },
        { kind: "operator", text: "=" },
        { kind: "function", text: "run" },
        { kind: "string", text: '"42"' },
        { kind: "comment", text: "// ready" },
      ]),
    );
  });

  it("keeps arithmetic operators separate from adjacent numbers", () => {
    expect(tokenizeCode("const total = 1+2;", "ts")).toEqual(
      expect.arrayContaining([
        { kind: "number", text: "1" },
        { kind: "operator", text: "+" },
        { kind: "number", text: "2" },
      ]),
    );
  });
});
