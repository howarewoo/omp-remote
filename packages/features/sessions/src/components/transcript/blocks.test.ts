import { describe, expect, it } from "vitest";
import { parseTranscriptBlocks } from "./blocks.js";

describe("parseTranscriptBlocks", () => {
  it("marks additions and deletions inside fenced diffs", () => {
    expect(
      parseTranscriptBlocks(
        [
          "Updated the component:",
          "```diff",
          " const stable = true;",
          "-const tone = 'blue';",
          "+const tone = 'green';",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Updated the component:" },
      {
        kind: "diff",
        lines: [
          { kind: "context", text: " const stable = true;" },
          { kind: "removed", text: "-const tone = 'blue';" },
          { kind: "added", text: "+const tone = 'green';" },
        ],
      },
    ]);
  });

  it("keeps unified diff metadata distinct from following prose", () => {
    expect(
      parseTranscriptBlocks(
        [
          "diff --git a/source.ts b/source.ts",
          "--- a/source.ts",
          "+++ b/source.ts",
          "@@ -1 +1 @@",
          "-const before = true;",
          "+const after = true;",
          "Finished.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        kind: "diff",
        lines: [
          { kind: "meta", text: "diff --git a/source.ts b/source.ts" },
          { kind: "meta", text: "--- a/source.ts" },
          { kind: "meta", text: "+++ b/source.ts" },
          { kind: "meta", text: "@@ -1 +1 @@" },
          { kind: "removed", text: "-const before = true;" },
          { kind: "added", text: "+const after = true;" },
        ],
      },
      { kind: "text", text: "Finished." },
    ]);
  });

  it("does not color ordinary prose that starts with plus or minus", () => {
    expect(parseTranscriptBlocks("- Removed clutter\n+ Added clarity")).toEqual([
      { kind: "text", text: "- Removed clutter\n+ Added clarity" },
    ]);
  });

  it("extracts a labeled fenced code block between prose", () => {
    expect(
      parseTranscriptBlocks(
        ["Use this helper:", "```ts", "const tone = 'cyan';", "```", "Then render it."].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Use this helper:" },
      { kind: "code", language: "ts", text: "const tone = 'cyan';" },
      { kind: "text", text: "Then render it." },
    ]);
  });

  it("keeps an unfinished streaming fence as code", () => {
    expect(parseTranscriptBlocks("```\nconst pending = true;")).toEqual([
      { kind: "code", language: null, text: "const pending = true;" },
    ]);
  });

  it("leaves inline backticks in ordinary transcript text", () => {
    expect(parseTranscriptBlocks("Run `pnpm test` next.")).toEqual([
      { kind: "text", text: "Run `pnpm test` next." },
    ]);
  });
});
