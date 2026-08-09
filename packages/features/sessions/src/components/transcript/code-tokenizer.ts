export type SyntaxTokenKind =
  | "plain"
  | "comment"
  | "keyword"
  | "function"
  | "variable"
  | "string"
  | "number"
  | "type"
  | "operator"
  | "punctuation";

export type SyntaxToken = {
  kind: SyntaxTokenKind;
  text: string;
};

const CODE_IDENTIFIER_PATTERN = /[$A-Za-z_]/;
const CODE_IDENTIFIER_CONTINUATION_PATTERN = /[$\w]/;
const CODE_OPERATOR_PATTERN = /[=+\-*/%!?&|<>^~]/;
const CODE_PUNCTUATION_PATTERN = /[()[\]{},.;:]/;
const HASH_COMMENT_LANGUAGES = new Set([
  "bash",
  "fish",
  "make",
  "makefile",
  "py",
  "python",
  "rb",
  "ruby",
  "sh",
  "shell",
  "toml",
  "yaml",
  "yml",
  "zsh",
]);
const CODE_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "match",
  "new",
  "null",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "raise",
  "return",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

export function tokenizeCode(code: string, language?: string | null): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const normalizedLanguage = language?.toLowerCase() ?? "";
  let cursor = 0;

  const push = (kind: SyntaxTokenKind, text: string) => {
    if (!text) return;
    const previous = tokens.at(-1);
    if (previous?.kind === kind) {
      previous.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  while (cursor < code.length) {
    const character = code[cursor] ?? "";
    const next = code[cursor + 1] ?? "";

    if (/\s/.test(character)) {
      const start = cursor;
      while (cursor < code.length && /\s/.test(code[cursor] ?? "")) cursor += 1;
      push("plain", code.slice(start, cursor));
      continue;
    }

    if (character === "/" && next === "/") {
      const end = code.indexOf("\n", cursor);
      const nextCursor = end === -1 ? code.length : end;
      push("comment", code.slice(cursor, nextCursor));
      cursor = nextCursor;
      continue;
    }

    if (character === "/" && next === "*") {
      const end = code.indexOf("*/", cursor + 2);
      const nextCursor = end === -1 ? code.length : end + 2;
      push("comment", code.slice(cursor, nextCursor));
      cursor = nextCursor;
      continue;
    }

    if (character === "#" && HASH_COMMENT_LANGUAGES.has(normalizedLanguage)) {
      const end = code.indexOf("\n", cursor);
      const nextCursor = end === -1 ? code.length : end;
      push("comment", code.slice(cursor, nextCursor));
      cursor = nextCursor;
      continue;
    }

    if (code.startsWith("<!--", cursor)) {
      const end = code.indexOf("-->", cursor + 4);
      const nextCursor = end === -1 ? code.length : end + 3;
      push("comment", code.slice(cursor, nextCursor));
      cursor = nextCursor;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = cursor;
      cursor += 1;
      while (cursor < code.length) {
        if (code[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        const current = code[cursor];
        cursor += 1;
        if (current === quote) break;
      }
      push("string", code.slice(start, cursor));
      continue;
    }

    if (/\d/.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < code.length) {
        const current = code[cursor] ?? "";
        if (/[\dA-Fa-f_xXob.]/.test(current)) {
          cursor += 1;
          continue;
        }
        if ((current === "+" || current === "-") && /[eE]/.test(code[cursor - 1] ?? "")) {
          cursor += 1;
          continue;
        }
        break;
      }
      push("number", code.slice(start, cursor));
      continue;
    }

    if (CODE_IDENTIFIER_PATTERN.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < code.length && CODE_IDENTIFIER_CONTINUATION_PATTERN.test(code[cursor] ?? "")) {
        cursor += 1;
      }
      const value = code.slice(start, cursor);
      let lookahead = cursor;
      while (/\s/.test(code[lookahead] ?? "")) lookahead += 1;
      const kind = CODE_KEYWORDS.has(value)
        ? "keyword"
        : /^[A-Z]/.test(value)
          ? "type"
          : code[lookahead] === "("
            ? "function"
            : "variable";
      push(kind, value);
      continue;
    }

    if (CODE_OPERATOR_PATTERN.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < code.length && CODE_OPERATOR_PATTERN.test(code[cursor] ?? "")) cursor += 1;
      push("operator", code.slice(start, cursor));
      continue;
    }

    if (CODE_PUNCTUATION_PATTERN.test(character)) {
      push("punctuation", character);
    } else {
      push("plain", character);
    }
    cursor += 1;
  }

  return tokens;
}
