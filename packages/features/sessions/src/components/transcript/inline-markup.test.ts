import { describe, expect, it } from "vitest";
import { parseInlineTranscript } from "./inline-markup.js";

describe("OMP-style transcript formatting", () => {
  it("parses the inline markdown roles used by the OMP stream", () => {
    expect(parseInlineTranscript("Use **bold**, `pnpm test`, and [docs](https://omp.sh).")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: ", " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: ", and " },
      { kind: "link", text: "docs", href: "https://omp.sh" },
      { kind: "text", text: "." },
    ]);
  });
  it("tokenizes absolute HTTP(S) URLs without sentence punctuation or unbalanced delimiters", () => {
    expect(parseInlineTranscript("See https://example.com/path_(safe), then https://omp.sh/docs.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/path_(safe)", href: "https://example.com/path_(safe)" },
      { kind: "text", text: ", then " },
      { kind: "link", text: "https://omp.sh/docs", href: "https://omp.sh/docs" },
      { kind: "text", text: "." },
    ]);
  });
  it("keeps escaped backslashes outside URL anchors", () => {
    expect(parseInlineTranscript("See https://example.com/project-url\\")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/project-url", href: "https://example.com/project-url" },
      { kind: "text", text: "\\" },
    ]);
  });

  it("keeps code, bare www, and unsafe schemes literal", () => {
    expect(
      parseInlineTranscript(
        "`https://code.example` www.example.com javascript:https://example.com foohttps://embedded.example https://safe.example",
      ),
    ).toEqual([
      { kind: "code", text: "https://code.example" },
      {
        kind: "text",
        text: " www.example.com javascript:https://example.com foohttps://embedded.example ",
      },
      { kind: "link", text: "https://safe.example", href: "https://safe.example" },
    ]);
  });
});
