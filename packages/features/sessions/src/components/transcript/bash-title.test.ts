import { describe, expect, it } from "vitest";
import { tokenizeBashTitle } from "./bash-title.js";

describe("Bash title rendering", () => {
  it("tokenizes chained commands losslessly with shell operators and quoted strings", () => {
    const title = String.raw`pnpm test && printf '%s\n' "https://example.com/a?b=1" > out.txt`;
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "operator").map((token) => token.text)).toEqual([
      "&&",
      ">",
    ]);
    expect(tokens.filter((token) => token.kind === "string").map((token) => token.text)).toEqual([
      "'%s\\n'",
      '"https://example.com/a?b=1"',
    ]);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.text)).toEqual([
      "pnpm",
      "test",
      "printf",
      "out.txt",
    ]);
  });

  it("keeps complete option and format words neutral", () => {
    const tokens = tokenizeBashTitle("grep -n +format --color=auto");

    expect(tokens.filter((token) => token.kind === "option").map((token) => token.text)).toEqual([
      "-n",
      "+format",
      "--color=auto",
    ]);
    expect(tokens.map((token) => token.text).join("")).toBe("grep -n +format --color=auto");
  });

  it("keeps escapes and URLs as lossless ordinary command text", () => {
    const title = String.raw`echo https://example.com/a\?b=1`;
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "string")).toHaveLength(0);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.text)).toEqual([
      "echo",
      "https://example.com/a\\?b=1",
    ]);
  });

  it("handles descriptor redirects and contextual bang tokens without false fallback", () => {
    const title = "! exec 10>out 2>&1 && if ! false; then echo foo!bar !; else ! true; fi";
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "operator").map((token) => token.text)).toEqual([
      "!",
      "10>",
      "2>&1",
      "&&",
      "!",
      ";",
      ";",
      "!",
      ";",
    ]);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.text)).toEqual([
      "exec",
      "out",
      "if",
      "false",
      "then",
      "echo",
      "foo!bar",
      "!",
      "else",
      "true",
      "fi",
    ]);
  });

  it("balances grouping and command substitutions inside complete quoted strings", () => {
    const title = 'echo "$(date)" `whoami` (printf ok)';
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "string").map((token) => token.text)).toEqual([
      '"$(date)"',
      "`whoami`",
    ]);
    expect(tokens.filter((token) => token.kind === "operator").map((token) => token.text)).toEqual([
      "(",
      ")",
    ]);
  });

  it.each([
    'echo "unfinished',
    "echo trailing\\",
    "echo (",
    "echo foo >&",
    "echo $(date",
    "echo foo | | cat",
    "| cat",
    "echo (date",
    "echo foo)",
    'echo "$(date"',
    "echo `date",
    "echo >>> out",
  ])("falls back to a plain lossless title for incomplete shell text: %s", (title) => {
    expect(tokenizeBashTitle(title)).toEqual([{ kind: "plain", text: title }]);
  });
});
