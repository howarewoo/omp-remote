import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  type ActiveSubagent,
  type AskRequest,
  type AskResponse,
  type Effort,
  filterMainSessions,
  type Session,
  type SessionBranchTopology,
  type SessionFileChangesResponse,
  type TranscriptImage,
} from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import {
  type FormEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SessionBranchSelector } from "./session-branch-selector.js";
import { formatSessionFileChangesMetadata, SessionFileChangesViewer } from "./session-file-changes-viewer.js";
import { SubagentSessionViewer } from "./subagent-session-viewer.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "./ui/drawer.js";
import { Input } from "./ui/input.js";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "./ui/message-scroller.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar.js";
import { Textarea } from "./ui/textarea.js";
import { cn } from "./ui/utils.js";

type ComposerMode = "prompt" | "steer" | "follow_up";
type SessionSection = {
  id: "terminal" | "daemon" | "disconnected";
  label: "Live terminal sessions" | "Live daemon-hosted sessions" | "Disconnected";
  sessions: Session[];
};
type NotificationState = "blocked" | "enabled" | "error" | "prompt" | "unsupported";
type NotificationControl = { disabled: boolean; label: string };

const EMPTY_MODEL_OPTIONS: NonNullable<Session["availableModels"]> = [];
const SKILL_COMMAND_PREFIX = "skill:";
const SKILL_SUGGESTION_LIMIT = 8;
const SKILL_SUGGESTION_LIST_ID = "composer-skill-suggestions";
const NOTIFICATION_CONTROL: Record<NotificationState, NotificationControl> = {
  blocked: { disabled: true, label: "Notifications blocked in browser settings" },
  enabled: { disabled: true, label: "Session notifications enabled" },
  error: { disabled: false, label: "Retry enabling session notifications" },
  prompt: { disabled: false, label: "Enable session notifications" },
  unsupported: { disabled: true, label: "Session notifications unsupported" },
};

export function WorkingIndicator({ status }: { status: Session["status"] }) {
  if (status !== "running") return null;

  return (
    <Badge className="working-indicator" role="status">
      <span className="working-indicator-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      Working
    </Badge>
  );
}
export function getComposerAction(
  session: Pick<Session, "capabilities" | "status">,
  message: string,
): "abort" | "steer" | null {
  if (message.trim()) return "steer";
  return session.status === "running" && session.capabilities.includes("abort") ? "abort" : null;
}

/**
 * Returns the active session's skill commands matching the composer's leading slash token.
 */
export function getSkillSuggestions(
  message: string,
  skillCommands: readonly Session["skillCommands"][number][],
): Session["skillCommands"] {
  const match = /^\/(?:skill:)?([^\s]*)$/i.exec(message);
  if (!match) return [];
  const query = match[1]?.toLocaleLowerCase() ?? "";
  return skillCommands
    .filter(
      (command) =>
        command.name.startsWith(SKILL_COMMAND_PREFIX) &&
        command.name.slice(SKILL_COMMAND_PREFIX.length).toLocaleLowerCase().includes(query),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .slice(0, SKILL_SUGGESTION_LIMIT);
}

export function canKillSession(session: Pick<Session, "capabilities">): boolean {
  return session.capabilities.includes("kill");
}

type DiffLineKind = "meta" | "context" | "removed" | "added";

type DiffLine = {
  kind: DiffLineKind;
  text: string;
};

type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string | null }
  | { kind: "diff"; lines: DiffLine[] };

export type InlineTranscriptToken =
  | { kind: "text" | "strong" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

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
export type BashTitleTokenKind = "plain" | "word" | "operator" | "option" | "string";

export type BashTitleToken = {
  kind: BashTitleTokenKind;
  text: string;
};

const BASH_TITLE_PREFIX = "Bash: ";
const BASH_TITLE_OPERATORS = [
  "&>>",
  "<<<",
  ">>>",
  ";;&",
  ">&",
  "<&",
  ";&",
  "&&",
  "||",
  ">>",
  "<<",
  "<>",
  ">|",
  "|&",
  "&>",
  ";;",
  "(",
  ")",
  ";",
  "|",
  "&",
  ">",
  "<",
] as const;

type BashTitleTokenPart = { kind: "word" | "string"; text: string };
const BASH_TITLE_INCOMPLETE_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  "<<<": true,
  ">>": true,
  "<<": true,
  "<>": true,
  ">|": true,
  "|&": true,
  "&>": true,
  "&>>": true,
  ">&": true,
  "<&": true,
  "|": true,
  ">": true,
  "<": true,
  "(": true,
  "!": true,
};

function bashTitleOperatorAt(text: string, index: number): string | null {
  for (const operator of BASH_TITLE_OPERATORS) {
    if (text.startsWith(operator, index)) return operator;
  }
  return null;
}

const BASH_TITLE_REDIRECTION_OPERATORS: Record<string, true> = {
  "&>>": true,
  "<<<": true,
  ">>": true,
  "<<": true,
  "<>": true,
  ">|": true,
  "&>": true,
  ">&": true,
  "<&": true,
  ">": true,
  "<": true,
};
const BASH_TITLE_MALFORMED_OPERATORS: Record<string, true> = {
  ">>>": true,
};
const BASH_TITLE_COMMAND_PREFIX_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  "|": true,
  "|&": true,
  ";": true,
  ";;": true,
  ";&": true,
  ";;&": true,
  "(": true,
  "!": true,
};
const BASH_TITLE_BINARY_OPERATORS: Record<string, true> = {
  "&&": true,
  "||": true,
  "|": true,
  "|&": true,
};
const BASH_TITLE_COMMAND_PREFIX_WORDS: Record<string, true> = {
  if: true,
  elif: true,
  else: true,
  while: true,
  until: true,
  do: true,
  time: true,
  coproc: true,
  "{": true,
};

function previousSignificantBashTitleToken(tokens: readonly BashTitleToken[]): BashTitleToken | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind !== "plain" || !/^\s*$/.test(token.text)) return token;
  }
  return undefined;
}

/**
 * Tokenizes the suffix of a normalized Bash tool title without changing its text.
 * A recognized incomplete or malformed streaming shell fragment is intentionally left unstyled.
 */
export function tokenizeBashTitle(text: string): BashTitleToken[] {
  const tokens: BashTitleToken[] = [];
  let parts: BashTitleTokenPart[] = [];
  let wordHasContent = false;
  let optionWord = false;

  const flushWord = () => {
    if (parts.length === 0) return;
    if (optionWord) {
      tokens.push({ kind: "option", text: parts.map((part) => part.text).join("") });
    } else {
      for (const part of parts) {
        const previous = tokens[tokens.length - 1];
        if (part.kind === "word" && previous?.kind === "word") {
          previous.text += part.text;
        } else {
          tokens.push({ kind: part.kind, text: part.text });
        }
      }
    }
    parts = [];
    wordHasContent = false;
    optionWord = false;
  };

  const plainFallback = () => [{ kind: "plain" as const, text }];

  let index = 0;
  let parenthesisDepth = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (/\s/.test(character)) {
      flushWord();
      const start = index;
      do {
        index += 1;
      } while (index < text.length && /\s/.test(text.charAt(index)));
      tokens.push({ kind: "plain", text: text.slice(start, index) });
      continue;
    }

    const previousToken = previousSignificantBashTitleToken(tokens);
    const bangOperator =
      character === "!" &&
      !wordHasContent &&
      parts.length === 0 &&
      (index + 1 === text.length || /\s/.test(text.charAt(index + 1))) &&
      (!previousToken ||
        (previousToken.kind === "operator" && BASH_TITLE_COMMAND_PREFIX_OPERATORS[previousToken.text]) ||
        (previousToken.kind === "word" &&
          (previousToken.text === "then" || BASH_TITLE_COMMAND_PREFIX_WORDS[previousToken.text])));
    let operator = bangOperator ? "!" : bashTitleOperatorAt(text, index);
    let operatorStart = index;
    if (!operator && !wordHasContent && parts.length === 0 && /\d/.test(character)) {
      let descriptorEnd = index + 1;
      while (descriptorEnd < text.length && /\d/.test(text.charAt(descriptorEnd))) descriptorEnd += 1;
      const descriptorOperator = bashTitleOperatorAt(text, descriptorEnd);
      if (descriptorOperator && BASH_TITLE_REDIRECTION_OPERATORS[descriptorOperator]) {
        operator = descriptorOperator;
        operatorStart = descriptorEnd;
      }
    }
    if (operator) {
      if (BASH_TITLE_MALFORMED_OPERATORS[operator]) return plainFallback();
      if (
        BASH_TITLE_BINARY_OPERATORS[operator] &&
        !wordHasContent &&
        (!previousToken ||
          (previousToken.kind === "operator" &&
            previousToken.text !== ")" &&
            !/^(?:\d+)?[<>]&(?:\d+|-)$/.test(previousToken.text)))
      ) {
        return plainFallback();
      }
      flushWord();
      if (operator === "(") {
        parenthesisDepth += 1;
      } else if (operator === ")") {
        if (parenthesisDepth === 0) return plainFallback();
        parenthesisDepth -= 1;
      }
      let operatorEnd = operatorStart + operator.length;
      if (operator === ">&" || operator === "<&") {
        if (/\d/.test(text.charAt(operatorEnd))) {
          do {
            operatorEnd += 1;
          } while (operatorEnd < text.length && /\d/.test(text.charAt(operatorEnd)));
        } else if (text.charAt(operatorEnd) === "-") {
          operatorEnd += 1;
        }
      }
      tokens.push({ kind: "operator", text: text.slice(index, operatorEnd) });
      index = operatorEnd;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = index;
      let nestedQuote: "'" | '"' | "`" | null = null;
      let quotedSubstitutionDepth = 0;
      let closed = false;
      index += 1;
      while (index < text.length) {
        const current = text.charAt(index);
        if (nestedQuote) {
          if (current === nestedQuote) {
            nestedQuote = null;
            index += 1;
            continue;
          }
          if (nestedQuote !== "'" && current === "\\") {
            if (index + 1 >= text.length) return plainFallback();
            index += 2;
            continue;
          }
          index += 1;
          continue;
        }
        if (quote !== "'" && current === "\\") {
          if (index + 1 >= text.length) return plainFallback();
          index += 2;
          continue;
        }
        if (quote !== "'" && current === "$" && text.charAt(index + 1) === "(") {
          quotedSubstitutionDepth += 1;
          index += 2;
          continue;
        }
        if (quotedSubstitutionDepth > 0) {
          if (current === "(") quotedSubstitutionDepth += 1;
          else if (current === ")") quotedSubstitutionDepth -= 1;
          else if (current === "'" || current === '"' || current === "`") nestedQuote = current;
          index += 1;
          continue;
        }
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (quote === '"' && current === "`") nestedQuote = "`";
        index += 1;
      }
      if (!closed || quotedSubstitutionDepth > 0 || nestedQuote) return plainFallback();
      parts.push({ kind: "string", text: text.slice(start, index) });
      wordHasContent = true;
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= text.length) return plainFallback();
      const start = index;
      index += 2;
      parts.push({ kind: "word", text: text.slice(start, index) });
      wordHasContent = true;
      continue;
    }

    const start = index;
    while (index < text.length) {
      const current = text.charAt(index);
      if (/\s/.test(current) || current === "'" || current === '"' || current === "`" || current === "\\") {
        break;
      }
      if (bashTitleOperatorAt(text, index)) break;
      index += 1;
    }
    if (index === start) {
      index += 1;
      parts.push({ kind: "word", text: character });
    } else {
      parts.push({ kind: "word", text: text.slice(start, index) });
    }
    if (!wordHasContent && (character === "-" || character === "+")) optionWord = true;
    wordHasContent = true;
  }
  flushWord();
  if (parenthesisDepth > 0) return plainFallback();
  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const token = tokens[tokenIndex];
    if (!token) continue;
    if (token.kind === "plain" && /^\s*$/.test(token.text)) continue;
    if (token.kind === "operator" && BASH_TITLE_INCOMPLETE_OPERATORS[token.text.replace(/^\d+/, "")]) {
      return plainFallback();
    }
    break;
  }
  return tokens;
}

const INLINE_MARKUP_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>"'`\\]+)/g;
const ABSOLUTE_HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
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
function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
function hasSafeUrlBoundary(text: string, start: number): boolean {
  return start === 0 || /[\s("'`[{<]/.test(text[start - 1] ?? "");
}

function trimUrlCandidate(value: string): { href: string; trailing: string } {
  let href = value;
  let trailing = "";

  const punctuation = href.match(URL_TRAILING_PUNCTUATION)?.[0] ?? "";
  if (punctuation) {
    href = href.slice(0, -punctuation.length);
    trailing = punctuation + trailing;
  }

  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (href.endsWith(closing)) {
      const openingCount = [...href].filter((character) => character === opening).length;
      const closingCount = [...href].filter((character) => character === closing).length;
      if (closingCount <= openingCount) break;
      href = href.slice(0, -1);
      trailing = closing + trailing;
    }
  }

  return { href, trailing };
}

function tokenizeSafeHttpUrls(text: string): InlineTranscriptToken[] {
  const tokens: InlineTranscriptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(ABSOLUTE_HTTP_URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const { href, trailing } = trimUrlCandidate(raw);
    if (!href || !isSafeHttpUrl(href) || !hasSafeUrlBoundary(text, start)) continue;
    if (start < cursor) continue;
    if (start > cursor) tokens.push({ kind: "text", text: text.slice(cursor, start) });
    tokens.push({ kind: "link", text: href, href });
    if (trailing) tokens.push({ kind: "text", text: trailing });
    cursor = start + raw.length;
  }

  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
}

function pushLiteralTextToken(tokens: InlineTranscriptToken[], text: string) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.kind === "text") {
    previous.text += text;
  } else {
    tokens.push({ kind: "text", text });
  }
}

function pushSafeHttpTokens(tokens: InlineTranscriptToken[], text: string) {
  for (const token of tokenizeSafeHttpUrls(text)) {
    if (token.kind === "text") {
      pushLiteralTextToken(tokens, token.text);
    } else {
      tokens.push(token);
    }
  }
}

export function parseInlineTranscript(text: string): InlineTranscriptToken[] {
  const tokens: InlineTranscriptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_MARKUP_PATTERN)) {
    const start = match.index;
    if (start < cursor) continue;
    if (start > cursor) pushSafeHttpTokens(tokens, text.slice(cursor, start));

    const raw = match[0];
    if (raw.startsWith("`")) {
      tokens.push({ kind: "code", text: raw.slice(1, -1) });
    } else if (raw.startsWith("**")) {
      tokens.push({ kind: "strong", text: raw.slice(2, -2) });
    } else if (raw.startsWith("[")) {
      const labelEnd = raw.indexOf("](");
      tokens.push({
        kind: "link",
        text: raw.slice(1, labelEnd),
        href: raw.slice(labelEnd + 2, -1),
      });
    } else {
      const { href, trailing } = trimUrlCandidate(raw);
      if (!isSafeHttpUrl(href) || !hasSafeUrlBoundary(text, start)) {
        pushLiteralTextToken(tokens, raw);
      } else {
        tokens.push({ kind: "link", text: href, href });
        if (trailing) tokens.push({ kind: "text", text: trailing });
      }
    }
    cursor = start + raw.length;
  }

  if (cursor < text.length) pushSafeHttpTokens(tokens, text.slice(cursor));
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
}

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

const DIFF_META_PATTERN =
  /^(?:diff --git |index |--- |\+\+\+ |@@ |new file mode |deleted file mode |similarity index |rename from |rename to |Binary files |\\ No newline at end of file)/;

function classifyDiffLine(line: string): DiffLine {
  if (DIFF_META_PATTERN.test(line)) return { kind: "meta", text: line };
  if (line.startsWith("+")) return { kind: "added", text: line };
  if (line.startsWith("-")) return { kind: "removed", text: line };
  return { kind: "context", text: line };
}

function startsRawDiff(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("@@ ") ||
    (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ") === true)
  );
}

function continuesRawDiff(line: string): boolean {
  return line === "" || DIFF_META_PATTERN.test(line) || /^[ +\\-]/.test(line);
}

export function parseTranscriptBlocks(text: string): TranscriptBlock[] {
  const sourceLines = text.split("\n");
  const blocks: TranscriptBlock[] = [];
  let textLines: string[] = [];
  let index = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    blocks.push({ kind: "text", text: textLines.join("\n") });
    textLines = [];
  };

  while (index < sourceLines.length) {
    const line = sourceLines[index] ?? "";
    const fence = line.match(/^```([A-Za-z0-9_+#.-]*)\s*$/);

    if (fence) {
      flushText();
      const language = fence[1] || null;
      const normalizedLanguage = language?.toLowerCase();
      const codeLines: string[] = [];
      index += 1;
      while (index < sourceLines.length && !/^```\s*$/.test(sourceLines[index] ?? "")) {
        codeLines.push(sourceLines[index] ?? "");
        index += 1;
      }
      if (index < sourceLines.length) index += 1;

      if (normalizedLanguage === "diff" || normalizedLanguage === "patch") {
        blocks.push({ kind: "diff", lines: codeLines.map(classifyDiffLine) });
      } else {
        blocks.push({ kind: "code", text: codeLines.join("\n"), language });
      }
      continue;
    }

    if (startsRawDiff(sourceLines, index)) {
      flushText();
      const diffLines: DiffLine[] = [];
      while (index < sourceLines.length) {
        const diffLine = sourceLines[index] ?? "";
        if (diffLines.length > 0 && !continuesRawDiff(diffLine)) break;
        diffLines.push(classifyDiffLine(diffLine));
        index += 1;
      }
      blocks.push({ kind: "diff", lines: diffLines });
      continue;
    }

    textLines.push(line);
    index += 1;
  }

  flushText();
  return blocks;
}

export function groupSessionsForSidebar(sessions: Session[]): SessionSection[] {
  const terminal: Session[] = [];
  const daemon: Session[] = [];
  const disconnected: Session[] = [];

  for (const session of sessions) {
    if (!session.connected) {
      disconnected.push(session);
    } else {
      (session.source === "extension" ? terminal : daemon).push(session);
    }
  }

  const sections: SessionSection[] = [
    { id: "terminal", label: "Live terminal sessions", sessions: terminal },
    { id: "daemon", label: "Live daemon-hosted sessions", sessions: daemon },
    { id: "disconnected", label: "Disconnected", sessions: disconnected },
  ];
  return sections.filter((section) => section.sessions.length > 0);
}

export function formatSubagentActivityLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"} running`;
}

export function getActiveAskRequest(
  askRequests: readonly AskRequest[],
  selectedSessionId: string | null,
): AskRequest | null {
  return askRequests.find((request) => request.sessionId === selectedSessionId) ?? null;
}

export interface DashboardProps {
  sessions: Session[];
  askRequests: AskRequest[];
  savedWorkingDirectories: string[];
  sessionsReady: boolean;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  notificationState: NotificationState;
  selectedSessionId: string | null;
  onSelectedSessionChange(sessionId: string): void;
  onEnableNotifications(): Promise<void>;
  onLaunch(cwd: string, resume: string | null): Promise<string>;
  onSaveWorkingDirectory(cwd: string): Promise<void>;
  onRemoveWorkingDirectory(cwd: string): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onAbort(sessionId: string): Promise<void>;
  onKill(sessionId: string): Promise<void>;
  onSetModel(sessionId: string, model: string): Promise<void>;
  onSetEffort(sessionId: string, effort: Effort): Promise<void>;
  onRespondToAsk(sessionId: string, askRequestId: string, response: AskResponse): Promise<void>;
  onAskActivity(sessionId: string, askRequestId: string): Promise<void>;
  onSearchHistory(query: string): Promise<void>;
  onLoadMoreHistory(): Promise<void>;
  onLoadTranscript(sessionId: string): Promise<void>;
  onLoadSessionFileChanges(sessionId: string, signal?: AbortSignal): Promise<SessionFileChangesResponse>;
  onLoadSessionBranchTopology(sessionId: string, signal?: AbortSignal): Promise<SessionBranchTopology>;
  onSwitchBranch(sessionId: string, branch: string): Promise<void>;
}

export function Dashboard(props: DashboardProps) {
  return (
    <SidebarProvider>
      <DashboardContent {...props} />
    </SidebarProvider>
  );
}

function renderSafeHttpText(
  text: string,
  keyPrefix: string,
  onLinkClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
) {
  return tokenizeSafeHttpUrls(text).map((token, index) =>
    token.kind === "link" ? (
      <a
        className="transcript-link"
        href={token.href}
        key={`${keyPrefix}:${index}:link`}
        onClick={onLinkClick}
        rel="noreferrer"
        target="_blank"
      >
        {token.text}
      </a>
    ) : (
      <span key={`${keyPrefix}:${index}:text`}>{token.text}</span>
    ),
  );
}

function renderSafeHttpTextWithoutLinks(text: string, keyPrefix: string) {
  return tokenizeSafeHttpUrls(text).map((token, index) =>
    token.kind === "text" ? <span key={`${keyPrefix}:${index}:text`}>{token.text}</span> : null,
  );
}

function renderSafeHttpLinkSiblings(text: string, keyPrefix: string) {
  return tokenizeSafeHttpUrls(text)
    .filter((token): token is Extract<InlineTranscriptToken, { kind: "link" }> => token.kind === "link")
    .map((token, index) => (
      <a
        className="transcript-link"
        href={token.href}
        key={`${keyPrefix}:${index}:link`}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
      >
        {token.text}
      </a>
    ));
}
function renderPlainTextWithLinks(
  text: string,
  keyPrefix: string,
  className = "transcript-disclosure-text",
  onLinkClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
  elementKey?: string,
) {
  return (
    <pre className={className} key={elementKey}>
      {renderSafeHttpText(text, keyPrefix, onLinkClick)}
    </pre>
  );
}

const InlineTranscript = memo(function InlineTranscript({ text }: { text: string }) {
  const tokens = useMemo(() => parseInlineTranscript(text), [text]);

  return tokens.map((token, index) => {
    if (token.kind === "link") {
      return (
        <a
          className="transcript-link"
          href={token.href}
          key={`${index}:link`}
          rel="noreferrer"
          target="_blank"
        >
          {token.text}
        </a>
      );
    }
    if (token.kind === "code") {
      return <code key={`${index}:code`}>{token.text}</code>;
    }
    if (token.kind === "strong") {
      return <strong key={`${index}:strong`}>{renderSafeHttpText(token.text, `${index}:strong`)}</strong>;
    }
    return <span key={`${index}:text`}>{token.text}</span>;
  });
});

const TranscriptProse = memo(function TranscriptProse({ text }: { text: string }) {
  return (
    <div className="transcript-prose">
      {text.split("\n").map((line, index) => {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          const [, marks = "", content = ""] = heading;
          return (
            <span className="transcript-heading" data-level={marks.length} key={`${index}:heading`}>
              <InlineTranscript text={content} />
            </span>
          );
        }

        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
          const [, content = ""] = quote;
          return (
            <span className="transcript-quote" key={`${index}:quote`}>
              <InlineTranscript text={content} />
            </span>
          );
        }

        const listItem = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
        if (listItem) {
          const [, indent = "", marker = "", content = ""] = listItem;
          return (
            <span
              className="transcript-list-item"
              key={`${index}:list`}
              style={{ paddingInlineStart: `${Math.floor(indent.length / 2)}rem` }}
            >
              <i aria-hidden="true">{/^\d/.test(marker) ? marker : "•"}</i>
              <span>
                <InlineTranscript text={content} />
              </span>
            </span>
          );
        }

        if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          return <span aria-hidden="true" className="transcript-rule" key={`${index}:rule`} />;
        }

        if (!line) {
          return (
            <span
              aria-hidden="true"
              className="transcript-line transcript-line-empty"
              key={`${index}:empty`}
            />
          );
        }
        return (
          <span className="transcript-line" key={`${index}:line`}>
            <InlineTranscript text={line} />
          </span>
        );
      })}
    </div>
  );
});

const HighlightedCode = memo(function HighlightedCode({
  code,
  language,
}: {
  code: string;
  language: string | null;
}) {
  const tokens = useMemo(() => tokenizeCode(code, language), [code, language]);
  return (
    <code>
      {tokens.map((token, index) => (
        <span className={`syntax-${token.kind}`} key={`${index}:${token.kind}`}>
          {token.text}
        </span>
      ))}
    </code>
  );
});

export function TranscriptCodeBlock({ code, language }: { code: string; language: string | null }) {
  return (
    <details className="transcript-disclosure-frame code-block">
      <summary>
        <span className="code-block-chevron" aria-hidden="true" />
        <span>{language ?? "code"}</span>
        <span className="code-block-action">
          <span className="code-block-action-collapsed">Show code</span>
          <span className="code-block-action-expanded">Hide code</span>
        </span>
      </summary>
      <pre>
        <HighlightedCode code={code} language={language} />
      </pre>
    </details>
  );
}
function TranscriptDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="transcript-message-diff">
      {lines.map((line, index) => (
        <span className={cn("diff-line", `diff-${line.kind}`)} key={`${index}:${line.kind}`}>
          {line.text}
        </span>
      ))}
    </div>
  );
}

const SYSTEM_TEXT_PREVIEW_LENGTH = 180;

export function formatSystemTextPreview(text: string): string {
  const preview = text
    .slice(0, SYSTEM_TEXT_PREVIEW_LENGTH + 1)
    .replace(/\s+/g, " ")
    .trim();
  if (!preview) return "System message";
  if (text.length <= SYSTEM_TEXT_PREVIEW_LENGTH) return preview;
  return `${preview.slice(0, SYSTEM_TEXT_PREVIEW_LENGTH).trimEnd()}…`;
}

const TOOL_TEXT_PREVIEW_LINES = 10;
function formatToolTextFull(text: string): string {
  if (!/\S/.test(text)) return "No tool output";
  return text;
}

export function formatToolTextPreview(text: string): string {
  let end = text.length;
  if (text.charCodeAt(end - 1) === 10) {
    end -= 1;
    if (text.charCodeAt(end - 1) === 13) end -= 1;
  }
  if (end === 0) return formatToolTextFull("");

  let start = end;
  for (let line = 0; line < TOOL_TEXT_PREVIEW_LINES && start > 0; line += 1) {
    const newline = text.lastIndexOf("\n", start - 1);
    if (newline === -1) {
      start = 0;
      break;
    }
    start = newline;
  }
  if (start > 0) start += 1;

  const preview = text.slice(start, end);
  return formatToolTextFull(preview);
}

export type TodoTaskState = "pending" | "in-progress" | "completed" | "blocked" | "dropped";

export type TodoTask = {
  label: string;
  state: TodoTaskState;
  reason?: string;
};

export type TodoPhase = {
  name: string;
  state: TodoTaskState;
  tasks: TodoTask[];
};

export type TodoOverallProgress = {
  done: number;
  total: number;
  open?: number;
  blocked?: number;
};

export type TodoActivePhase = {
  index: number;
  total: number;
  name: string;
  done: number;
  taskTotal: number;
};

export type TodoResult = {
  overall: TodoOverallProgress;
  activePhase?: TodoActivePhase;
  phases: TodoPhase[];
};

const TODO_STATE_LABEL: Record<TodoTaskState, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  completed: "Completed",
  blocked: "Blocked",
  dropped: "Dropped",
};

function getTodoPhaseState(tasks: TodoTask[]): TodoTaskState {
  if (tasks.every((task) => task.state === "dropped")) return "dropped";
  if (tasks.every((task) => task.state === "completed" || task.state === "dropped")) return "completed";
  if (tasks.some((task) => task.state === "in-progress")) return "in-progress";
  if (tasks.some((task) => task.state === "blocked")) return "blocked";
  return "pending";
}

export function parseTodoResult(text: string): TodoResult | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  const overallPattern = /^Overall: (\d+)\/(\d+) done(?:, (\d+) open)?(?:, (\d+) blocked)?\.$/;
  const overallIndex = lines.findIndex((line) => overallPattern.test(line));
  if (overallIndex === -1) return null;
  for (let preambleIndex = 0; preambleIndex < overallIndex; preambleIndex += 1) {
    if (lines[preambleIndex]?.startsWith("Errors:")) return null;
  }
  const overallLine = lines[overallIndex];
  if (overallLine === undefined) return null;
  const overallMatch = overallPattern.exec(overallLine);
  if (!overallMatch) return null;
  const doneText = overallMatch?.[1];
  const totalText = overallMatch?.[2];
  if (doneText === undefined || totalText === undefined) return null;

  const done = Number(doneText);
  const total = Number(totalText);
  const open = overallMatch[3] === undefined ? undefined : Number(overallMatch[3]);
  const blocked = overallMatch[4] === undefined ? undefined : Number(overallMatch[4]);
  if (
    !Number.isSafeInteger(done) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    (open !== undefined && !Number.isSafeInteger(open)) ||
    (blocked !== undefined && !Number.isSafeInteger(blocked)) ||
    done > total ||
    ((open !== undefined || blocked !== undefined) && done + (open ?? 0) + (blocked ?? 0) !== total)
  ) {
    return null;
  }

  let lineIndex = overallIndex + 1;
  let activePhase: TodoResult["activePhase"];
  const activeMatch = /^Active phase (\d+)\/(\d+) "([^"\n]+)" \((\d+)\/(\d+)\)(?:\.| — .+)$/.exec(
    lines[lineIndex] ?? "",
  );
  if (activeMatch) {
    const indexText = activeMatch[1];
    const totalText = activeMatch[2];
    const name = activeMatch[3];
    const doneText = activeMatch[4];
    const taskTotalText = activeMatch[5];
    if (
      indexText === undefined ||
      totalText === undefined ||
      name === undefined ||
      doneText === undefined ||
      taskTotalText === undefined
    ) {
      return null;
    }
    const parsedActivePhase: TodoActivePhase = {
      index: Number(indexText),
      total: Number(totalText),
      name,
      done: Number(doneText),
      taskTotal: Number(taskTotalText),
    };
    if (
      !Number.isSafeInteger(parsedActivePhase.index) ||
      !Number.isSafeInteger(parsedActivePhase.total) ||
      !Number.isSafeInteger(parsedActivePhase.done) ||
      !Number.isSafeInteger(parsedActivePhase.taskTotal) ||
      parsedActivePhase.index < 1 ||
      parsedActivePhase.index > parsedActivePhase.total ||
      parsedActivePhase.taskTotal < 1 ||
      parsedActivePhase.done > parsedActivePhase.taskTotal ||
      parsedActivePhase.name.trim() !== parsedActivePhase.name
    ) {
      return null;
    }
    activePhase = parsedActivePhase;
    lineIndex += 1;
  }

  const phases: TodoPhase[] = [];
  let currentPhase: TodoPhase | undefined;
  for (; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) return null;
    const phaseMatch = /^ {2}([^:\n]+):$/.exec(line);
    const phaseName = phaseMatch?.[1];
    if (phaseName !== undefined) {
      if (phaseName.trim() !== phaseName) return null;
      currentPhase = { name: phaseName, state: "pending", tasks: [] };
      phases.push(currentPhase);
      continue;
    }

    const taskMatch =
      /^ {4}- \[([ xX])\] (.+?)(?: \((pending|in progress|completed|blocked|dropped)(?:: ([^)]+))?\))?$/.exec(
        line,
      );
    const checkbox = taskMatch?.[1];
    const label = taskMatch?.[2];
    const stateText = taskMatch?.[3];
    const reason = taskMatch?.[4];
    if (
      !taskMatch ||
      !currentPhase ||
      checkbox === undefined ||
      label === undefined ||
      label.trim() !== label ||
      (reason !== undefined && (stateText !== "blocked" || reason.trim() !== reason))
    ) {
      return null;
    }

    const checked = checkbox.toLowerCase() === "x";
    const explicitState: TodoTaskState | undefined =
      stateText === "in progress"
        ? "in-progress"
        : stateText === "pending" ||
            stateText === "completed" ||
            stateText === "blocked" ||
            stateText === "dropped"
          ? stateText
          : undefined;
    if (
      (checked && explicitState !== undefined && explicitState !== "completed") ||
      (!checked && explicitState === "completed")
    ) {
      return null;
    }
    currentPhase.tasks.push({
      label,
      state: explicitState ?? (checked ? "completed" : "pending"),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  if (phases.length === 0 || phases.some((phase) => phase.tasks.length === 0)) return null;
  let parsedTaskCount = 0;
  let parsedDoneCount = 0;
  let parsedOpenCount = 0;
  let parsedBlockedCount = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      parsedTaskCount += 1;
      if (task.state === "completed" || task.state === "dropped") parsedDoneCount += 1;
      else if (task.state === "blocked") parsedBlockedCount += 1;
      else parsedOpenCount += 1;
    }
  }
  if (
    parsedTaskCount !== total ||
    parsedDoneCount !== done ||
    parsedOpenCount !== (open ?? 0) ||
    parsedBlockedCount !== (blocked ?? 0)
  ) {
    return null;
  }

  for (const phase of phases) phase.state = getTodoPhaseState(phase.tasks);
  if (activePhase) {
    const phase = phases[activePhase.index - 1];
    if (phase === undefined) return null;
    let activeDoneCount = 0;
    for (const task of phase.tasks) {
      if (task.state === "completed" || task.state === "dropped") activeDoneCount += 1;
    }
    if (
      activePhase.total !== phases.length ||
      phase.name !== activePhase.name ||
      phase.tasks.length !== activePhase.taskTotal ||
      activeDoneCount !== activePhase.done
    ) {
      return null;
    }
  } else if (done !== total) {
    return null;
  }

  return {
    overall: {
      done,
      total,
      ...(open === undefined ? {} : { open }),
      ...(blocked === undefined ? {} : { blocked }),
    },
    ...(activePhase ? { activePhase } : {}),
    phases,
  };
}

export const TranscriptText = memo(function TranscriptText({ text }: { text: string }) {
  const blocks = useMemo(() => parseTranscriptBlocks(text), [text]);

  return (
    <div className="transcript-message">
      {blocks.map((block, index) => {
        if (block.kind === "text") {
          return <TranscriptProse key={`${index}:text`} text={block.text} />;
        }
        if (block.kind === "code") {
          return <TranscriptCodeBlock code={block.text} key={`${index}:code`} language={block.language} />;
        }
        return <TranscriptDiff key={`${index}:diff`} lines={block.lines} />;
      })}
    </div>
  );
});

type TranscriptEntryMessage = Session["messages"][number];

function getReadToolTarget(entry: TranscriptEntryMessage): string | undefined {
  return entry.readTarget ?? entry.text.match(/^\[([^\]\r\n]+)#[\dA-Fa-f]{4}\](?:\r?\n|$)/)?.[1];
}

function getReadToolFilename(target?: string): string | null {
  if (!target) return null;

  const { path } = splitReadTarget(target);
  return path.slice(path.lastIndexOf("/") + 1) || null;
}

export function findLatestTodoResult(messages: readonly TranscriptEntryMessage[]): TodoResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.role !== "tool" || entry.toolName !== "todo" || entry.streaming) continue;
    const todo = parseTodoResult(entry.text);
    if (todo) return todo;
  }
  return null;
}

function splitReadTarget(target: string): { path: string; selector: string } {
  const lastSlash = target.lastIndexOf("/");
  const selectorIndex = target.indexOf(":", lastSlash + 1);
  return selectorIndex === -1
    ? { path: target, selector: "" }
    : { path: target.slice(0, selectorIndex), selector: target.slice(selectorIndex) };
}

export function renderTranscriptMessageItems({ messages }: { messages: readonly TranscriptEntryMessage[] }) {
  return messages.map((entry) =>
    !entry.text && entry.role !== "tool" ? null : (
      <MessageScrollerItem key={entry.id} messageId={entry.id} scrollAnchor={entry.role === "user"}>
        <TranscriptEntry entry={entry} />
      </MessageScrollerItem>
    ),
  );
}

type MessageScrollerScrollRegistration = (handler: (() => void) | null) => void;

export function MessageScrollerScrollController({
  onScrollToEnd,
}: {
  onScrollToEnd: MessageScrollerScrollRegistration;
}) {
  const { scrollToEnd } = useMessageScroller();

  useEffect(() => {
    const scrollToEndImmediately = () => {
      scrollToEnd({ behavior: "auto" });
    };
    onScrollToEnd(scrollToEndImmediately);
    return () => onScrollToEnd(null);
  }, [onScrollToEnd, scrollToEnd]);

  return null;
}

const MemoizedBashTitle = memo(function BashTitle({ title }: { title: string }) {
  const suffix = title.slice(BASH_TITLE_PREFIX.length);
  const tokens = useMemo(() => tokenizeBashTitle(suffix), [suffix]);

  return (
    <span className="transcript-command-title">
      <span className="transcript-tool-name transcript-tool-name-bash">Bash</span>
      <span className="transcript-tool-title-detail">: </span>
      {tokens.map((token, index) =>
        token.kind === "plain" ? (
          token.text
        ) : (
          <span
            className={`transcript-command-token transcript-command-token-${token.kind}`}
            key={`${index}:${token.kind}`}
          >
            {token.text}
          </span>
        ),
      )}
    </span>
  );
});

const TOOL_NAME_COLOR_CLASS: Record<string, string> = {
  bash: "transcript-tool-name-bash",
  edit: "transcript-tool-name-edit",
  grep: "transcript-tool-name-grep",
  hub: "transcript-tool-name-hub",
  read: "transcript-tool-name-read",
  task: "transcript-tool-name-task",
  todo: "transcript-tool-name-todo",
  write: "transcript-tool-name-write",
  yield: "transcript-tool-name-yield",
};

const TOOL_TITLE_LABEL: Record<string, string> = {
  edit: "Edit",
  grep: "Grep",
  read: "Read",
  write: "Write",
};

function renderToolTitle(entry: Session["messages"][number], fallbackLabel: string) {
  const title = entry.toolTitle;
  const toolName = entry.toolName;
  const displayedTitle = title ?? fallbackLabel;
  const titleLabel = toolName ? TOOL_TITLE_LABEL[toolName] : undefined;
  if (toolName && titleLabel && displayedTitle.startsWith(`${titleLabel}:`)) {
    return (
      <>
        <span className={cn("transcript-tool-name", TOOL_NAME_COLOR_CLASS[toolName])}>{titleLabel}</span>
        <span className="transcript-tool-title-detail">{displayedTitle.slice(titleLabel.length)}</span>
      </>
    );
  }
  if (toolName === "bash" && title?.startsWith(BASH_TITLE_PREFIX)) {
    return <MemoizedBashTitle title={title} />;
  }
  return (
    <span className={cn("transcript-tool-name", toolName && TOOL_NAME_COLOR_CLASS[toolName])}>
      {fallbackLabel}
    </span>
  );
}

function TranscriptEntryHeader({
  entry,
  authorLabel,
  collapsible = false,
}: {
  entry: Session["messages"][number];
  authorLabel?: string;
  collapsible?: boolean;
}) {
  const resolvedAuthorLabel =
    authorLabel ??
    (entry.role === "assistant" ? "OMP" : entry.role === "user" ? "You" : (entry.toolName ?? entry.role));
  return (
    <header>
      <span className="message-author">
        <i aria-hidden="true">{entry.role === "assistant" ? "π" : entry.role === "user" ? "›" : "·"}</i>
        {renderToolTitle(entry, resolvedAuthorLabel)}
        {collapsible ? <span className="message-disclosure-chevron" aria-hidden="true" /> : null}
      </span>
      <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
      {entry.streaming ? <Badge className="streaming-badge">Streaming</Badge> : null}
    </header>
  );
}

export type DisclosureTranscriptSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; alt: string; source: string };

const DISCLOSURE_IMAGE_PATTERN = /(?<!\\)!\[([^\]\r\n]*)\]\((https:\/\/[^)\s]+)\)/g;

export function parseDisclosureImages(text: string): DisclosureTranscriptSegment[] {
  const segments: DisclosureTranscriptSegment[] = [];
  let textStart = 0;

  for (const match of text.matchAll(DISCLOSURE_IMAGE_PATTERN)) {
    const matchStart = match.index;
    if (matchStart > textStart) segments.push({ kind: "text", text: text.slice(textStart, matchStart) });
    segments.push({ kind: "image", alt: match[1] ?? "", source: match[2] ?? "" });
    textStart = matchStart + match[0].length;
  }

  if (textStart < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(textStart) });
  }
  return segments;
}

function renderDisclosureTranscriptText(
  text: string,
  linkify = true,
  onLinkClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void,
) {
  return linkify ? (
    renderPlainTextWithLinks(text, "disclosure", undefined, onLinkClick)
  ) : (
    <pre className="transcript-disclosure-text">{text}</pre>
  );
}

function DisclosureImage({
  alt,
  fallbackLabel,
  pending = false,
  source,
  variant,
}: {
  alt: string;
  fallbackLabel: string;
  pending?: boolean;
  source: string | null | undefined;
  variant: "thumbnail" | "expanded";
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  if (pending && !source) {
    const loading = `Loading image: ${fallbackLabel}`;
    return (
      <span className="disclosure-image">
        <span className="disclosure-image-fallback" role="status">
          {loading}
        </span>
      </span>
    );
  }

  const sourceLinkLabel = alt ? `Open image source: ${alt}` : "Open image source";

  if (!source || loadFailed) {
    const fallback = `Image unavailable: ${fallbackLabel}`;
    const fallbackNode = (
      <span aria-label={fallback} className="disclosure-image-fallback" role="img">
        {fallback}
      </span>
    );
    return (
      <span className="disclosure-image">
        {source && variant === "expanded" ? (
          <a
            aria-label={sourceLinkLabel}
            className="disclosure-image-link"
            href={source}
            rel="noreferrer"
            target="_blank"
          >
            {fallbackNode}
          </a>
        ) : (
          fallbackNode
        )}
      </span>
    );
  }

  const image = (
    <img
      alt={alt}
      className="disclosure-image-media"
      decoding="async"
      loading="lazy"
      onError={() => setLoadFailed(true)}
      referrerPolicy="no-referrer"
      src={source}
    />
  );

  return (
    <span className="disclosure-image">
      {variant === "expanded" ? (
        <a
          aria-label={sourceLinkLabel}
          className="disclosure-image-link"
          href={source}
          rel="noreferrer"
          target="_blank"
        >
          {image}
        </a>
      ) : (
        image
      )}
    </span>
  );
}

function getDisclosurePlainText(segments: readonly DisclosureTranscriptSegment[]): string {
  return segments
    .filter(
      (segment): segment is Extract<DisclosureTranscriptSegment, { kind: "text" }> => segment.kind === "text",
    )
    .map((segment) => segment.text)
    .join("");
}

type DisclosureTranscriptContentProps =
  | {
      preview: string;
      segments: readonly DisclosureTranscriptSegment[];
      variant: "thumbnail";
    }
  | {
      preview?: never;
      segments: readonly DisclosureTranscriptSegment[];
      variant: "expanded";
    };

function renderDisclosureTranscriptContent(props: DisclosureTranscriptContentProps) {
  const { segments, variant } = props;
  const images = segments.filter(
    (segment): segment is Extract<DisclosureTranscriptSegment, { kind: "image" }> => segment.kind === "image",
  );

  return (
    <div className="transcript-disclosure-content" data-variant={variant}>
      {variant === "thumbnail" ? (
        <>
          {props.preview || images.length === 0
            ? renderDisclosureTranscriptText(props.preview, true, (event) => event.stopPropagation())
            : null}
          {images.map((image, index) => (
            <DisclosureImage
              alt={image.alt}
              fallbackLabel={image.alt || "image"}
              key={`${index}:${image.source}`}
              source={image.source}
              variant={variant}
            />
          ))}
        </>
      ) : (
        segments.map((segment, index) =>
          segment.kind === "text" ? (
            renderPlainTextWithLinks(
              segment.text,
              `disclosure:${index}`,
              "transcript-disclosure-text",
              (event) => event.stopPropagation(),
              `${index}:text`,
            )
          ) : (
            <DisclosureImage
              alt={segment.alt}
              fallbackLabel={segment.alt || "image"}
              key={`${index}:${segment.source}`}
              source={segment.source}
              variant={variant}
            />
          ),
        )
      )}
    </div>
  );
}

export function SystemTranscriptText({ entry }: { entry: Session["messages"][number] }) {
  const segments = parseDisclosureImages(entry.text);
  const plainText = getDisclosurePlainText(segments);
  const preview =
    plainText.trim().length > 0 || !segments.some((segment) => segment.kind === "image")
      ? formatSystemTextPreview(plainText)
      : "";

  return (
    <details className="system-message-disclosure transcript-disclosure-frame">
      <summary>
        <TranscriptEntryHeader entry={entry} collapsible />
        {renderDisclosureTranscriptContent({ preview, segments, variant: "thumbnail" })}
      </summary>
      {renderDisclosureTranscriptContent({ segments, variant: "expanded" })}
    </details>
  );
}

const MemoizedSystemTranscriptText = memo(SystemTranscriptText);

function TranscriptEntryContent({ entry }: { entry: Session["messages"][number] }) {
  return entry.presentation === "diff" ? (
    <div className="transcript-message">
      <TranscriptDiff lines={entry.text.split("\n").map(classifyDiffLine)} />
    </div>
  ) : (
    <TranscriptText text={entry.text} />
  );
}

function ToolOutputDivider() {
  return (
    <div className="tool-output-divider">
      <span>Output</span>
    </div>
  );
}

type TodoPresentation = {
  activeTask?: TodoTask;
  activeLabel: string;
  activeState: TodoTaskState;
  blocked: number;
  open: number;
  progressVerb: "complete" | "resolved";
};

function getTodoPresentation(todo: TodoResult): TodoPresentation {
  const activePhase = todo.activePhase ? todo.phases[todo.activePhase.index - 1] : undefined;
  let activeTask = activePhase?.tasks.find((task) => task.state === "in-progress");
  if (!activeTask) {
    for (const phase of todo.phases) {
      activeTask = phase.tasks.find((task) => task.state === "in-progress");
      if (activeTask) break;
    }
  }
  activeTask ??= activePhase?.tasks.find((task) => task.state === "blocked" || task.state === "pending");

  const blocked = todo.overall.blocked ?? 0;
  const open = todo.overall.open ?? todo.overall.total - todo.overall.done - blocked;
  const hasDroppedTasks = todo.phases.some((phase) => phase.tasks.some((task) => task.state === "dropped"));
  const terminalState: TodoTaskState = hasDroppedTasks ? "dropped" : "completed";

  return {
    ...(activeTask ? { activeTask } : {}),
    activeLabel:
      activeTask?.label ??
      (todo.overall.done === todo.overall.total
        ? hasDroppedTasks
          ? "No tasks remain"
          : "All tasks complete"
        : `${open} tasks open`),
    activeState: activeTask?.state ?? (todo.overall.done === todo.overall.total ? terminalState : "pending"),
    blocked,
    open,
    progressVerb: hasDroppedTasks ? "resolved" : "complete",
  };
}

function getTodoTrackerLabel(todo: TodoResult): string {
  const { activeLabel, activeTask, progressVerb } = getTodoPresentation(todo);
  const context = activeTask ? `${TODO_STATE_LABEL[activeTask.state]}: ${activeLabel}` : activeLabel;
  return `Open current Todo: ${todo.overall.done} of ${todo.overall.total} tasks ${progressVerb}. ${context}.`;
}

function TodoProgressSummary({ todo }: { todo: TodoResult }) {
  const { activeLabel, activeState, activeTask, blocked, open, progressVerb } = getTodoPresentation(todo);

  return (
    <div className="todo-tool-summary">
      <div className="todo-progress-copy">
        <strong>
          {todo.overall.done}/{todo.overall.total} {progressVerb}
        </strong>
        <span className="todo-progress-counts">
          <span>{open} open</span>
          {blocked > 0 ? <span className="todo-blocked-count">{blocked} blocked</span> : null}
        </span>
      </div>
      <progress
        aria-label={`Overall todo progress: ${todo.overall.done} of ${
          todo.overall.total
        } tasks ${progressVerb}`}
        max={todo.overall.total}
        value={todo.overall.done}
      />
      <div className="todo-active-task">
        <span aria-hidden="true" className="todo-state-marker" data-state={activeState} />
        <span>
          <span className="sr-only">{activeTask ? `${TODO_STATE_LABEL[activeTask.state]}: ` : ""}</span>
          {renderSafeHttpText(activeLabel, "todo-active")}
        </span>
      </div>
    </div>
  );
}
function TodoPhaseList({ todo }: { todo: TodoResult }) {
  return (
    <div className="todo-phase-list">
      {todo.phases.map((phase, phaseIndex) => (
        <section className="todo-phase" key={`${phaseIndex}:${phase.name}`}>
          <header>
            <h3>{renderSafeHttpText(phase.name, `todo-phase-${phaseIndex}`)}</h3>
            <Badge className={`todo-state-badge todo-state-${phase.state}`}>
              {TODO_STATE_LABEL[phase.state]}
            </Badge>
          </header>
          <ul>
            {phase.tasks.map((task, taskIndex) => (
              <li key={`${taskIndex}:${task.label}`}>
                <span aria-hidden="true" className="todo-state-marker" data-state={task.state} />
                <span className="todo-task-label">
                  <span className="sr-only">{TODO_STATE_LABEL[task.state]}: </span>
                  {renderSafeHttpText(task.label, `todo-task-${phaseIndex}`)}
                  {task.reason ? (
                    <span className="todo-task-reason">
                      <span className="sr-only">Blocked reason: </span>
                      {renderSafeHttpText(task.reason, `todo-reason-${phaseIndex}`)}
                    </span>
                  ) : null}
                </span>
                <Badge aria-hidden="true" className={`todo-state-badge todo-state-${task.state}`}>
                  {TODO_STATE_LABEL[task.state]}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function TodoToolTranscript({
  entry,
  todo,
}: {
  entry: Session["messages"][number];
  todo: TodoResult;
}) {
  return (
    <details className="tool-message-disclosure transcript-disclosure-frame todo-tool-disclosure">
      <summary>
        <TranscriptEntryHeader entry={entry} collapsible />
        <ToolOutputDivider />
        <TodoProgressSummary todo={todo} />
      </summary>
      <TodoPhaseList todo={todo} />
    </details>
  );
}

const MemoizedTodoToolTranscript = memo(TodoToolTranscript);

const READ_RESULT_PREVIEW_LINES = 12;
const URI_LIKE_READ_TARGET_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const EMPTY_TRANSCRIPT_IMAGES: readonly TranscriptImage[] = [];
type TranscriptImageSource = {
  image: TranscriptImage;
  source: string | null | undefined;
};
const EMPTY_TRANSCRIPT_IMAGE_SOURCES: readonly TranscriptImageSource[] = [];

function getReadImageLabel(readTarget: string | undefined): string {
  if (!readTarget) return "Read";
  if (URI_LIKE_READ_TARGET_PATTERN.test(readTarget)) return readTarget;
  return getReadToolFilename(readTarget) ?? "Read";
}

function createTranscriptImageObjectUrl(image: TranscriptImage): string | null {
  if (image.status !== "available") return null;

  try {
    const binary = globalThis.atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return globalThis.URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
  } catch {
    return null;
  }
}

function useTranscriptImageObjectUrls(images: readonly TranscriptImage[]): readonly TranscriptImageSource[] {
  const [state, setState] = useState<{
    images: readonly TranscriptImage[];
    sources: readonly TranscriptImageSource[];
  }>({ images: EMPTY_TRANSCRIPT_IMAGES, sources: EMPTY_TRANSCRIPT_IMAGE_SOURCES });

  useEffect(() => {
    if (images.length === 0) {
      setState((current) =>
        current.images === images && current.sources === EMPTY_TRANSCRIPT_IMAGE_SOURCES
          ? current
          : { images, sources: EMPTY_TRANSCRIPT_IMAGE_SOURCES },
      );
      return;
    }
    const sources = images.map((image) => ({ image, source: createTranscriptImageObjectUrl(image) }));
    setState({ images, sources });

    return () => {
      for (const entry of sources) {
        if (entry.source) globalThis.URL.revokeObjectURL(entry.source);
      }
    };
  }, [images]);

  if (images.length === 0) return EMPTY_TRANSCRIPT_IMAGE_SOURCES;
  return state.images === images ? state.sources : images.map((image) => ({ image, source: undefined }));
}

function renderReadImageDisclosureContent({
  imageSources,
  readTarget,
  text,
  variant,
}: {
  imageSources: readonly TranscriptImageSource[];
  readTarget: string | undefined;
  text: string;
  variant: "thumbnail" | "expanded";
}) {
  const label = readTarget || "Read";

  return (
    <div className="transcript-disclosure-content" data-variant={variant}>
      {text || imageSources.length === 0 ? renderDisclosureTranscriptText(text) : null}
      {imageSources.map(({ image, source }, index) => (
        <DisclosureImage
          alt={label}
          fallbackLabel={label}
          key={`${index}:${image.status}:${source ?? ""}`}
          pending={image.status === "available" && source === undefined}
          source={source}
          variant={variant}
        />
      ))}
    </div>
  );
}

function ReadResultTranscript({
  entry,
  className,
  readTarget,
}: {
  entry: Session["messages"][number];
  className: string;
  readTarget: string | undefined;
}) {
  const images = entry.images ?? EMPTY_TRANSCRIPT_IMAGES;
  const imageSources = useTranscriptImageObjectUrls(images);
  const lines = entry.text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  const preview = lines.slice(0, READ_RESULT_PREVIEW_LINES).join("\n");
  const hiddenLineCount = Math.max(0, lines.length - READ_RESULT_PREVIEW_LINES);
  const readImageLabel = getReadImageLabel(readTarget);
  const authorLabel = readTarget ? `Read ${readImageLabel}` : "Read";
  const hasImages = images.length > 0;

  return (
    <div className={`${className} read-result-disclosure`}>
      <details className="read-result-content" open={false}>
        <summary>
          <TranscriptEntryHeader entry={entry} authorLabel={authorLabel} collapsible />
          <ToolOutputDivider />
          <div className="read-result-preview">
            {hasImages
              ? renderReadImageDisclosureContent({
                  imageSources,
                  readTarget: readImageLabel,
                  text: preview,
                  variant: "thumbnail",
                })
              : renderDisclosureTranscriptText(preview)}
            {hiddenLineCount > 0 ? (
              <span className="read-result-more">… {hiddenLineCount} more lines</span>
            ) : null}
          </div>
        </summary>
        {hasImages
          ? renderReadImageDisclosureContent({
              imageSources,
              readTarget: readImageLabel,
              text: entry.text,
              variant: "expanded",
            })
          : renderDisclosureTranscriptText(entry.text)}
      </details>
      {!hasImages && entry.readResolvedPath ? (
        <div className="read-result-output">
          <div className="read-result-resolved-path">
            <span>Resolved path: {entry.readResolvedPath}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ToolTranscriptText({ entry }: { entry: Session["messages"][number] }) {
  const todo = entry.toolName === "todo" ? parseTodoResult(entry.text) : null;
  if (todo) return <MemoizedTodoToolTranscript entry={entry} todo={todo} />;

  const isRead = entry.toolName === "read";
  const readTarget = getReadToolTarget(entry);
  const readFilename = isRead ? getReadToolFilename(readTarget) : null;
  const hasReadImages = isRead && Boolean(entry.images?.length);
  const isInspectableRead =
    isRead &&
    (hasReadImages || (readTarget ? URI_LIKE_READ_TARGET_PATTERN.test(readTarget) : readFilename === null));
  const isWrite = entry.toolName === "write";
  const authorLabel =
    entry.toolTitle ??
    (readFilename ? `Read: ${readFilename}` : isRead ? "Read" : (entry.toolName ?? entry.role));
  const className = "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure";

  if (isInspectableRead) {
    return <ReadResultTranscript className={className} entry={entry} readTarget={readTarget} />;
  }

  if (isRead) {
    return (
      <div className={className}>
        <div className="tool-message-header">
          <TranscriptEntryHeader entry={entry} authorLabel={authorLabel} />
        </div>
      </div>
    );
  }

  const rendersDisclosureImages = !isWrite && entry.presentation !== "diff";
  const disclosureSegments = rendersDisclosureImages ? parseDisclosureImages(entry.text) : null;
  const disclosurePlainText = disclosureSegments === null ? null : getDisclosurePlainText(disclosureSegments);
  const disclosurePreview =
    disclosureSegments === null || disclosurePlainText === null
      ? null
      : disclosurePlainText.trim().length > 0 ||
          !disclosureSegments.some((segment) => segment.kind === "image")
        ? formatToolTextPreview(disclosurePlainText)
        : "";

  return (
    <details className={className} open={entry.toolName === "edit" || isWrite}>
      <summary>
        <TranscriptEntryHeader entry={entry} authorLabel={authorLabel} collapsible />
        <ToolOutputDivider />
        {isWrite ? null : entry.presentation === "diff" ? (
          <pre className="tool-message-preview">{formatToolTextPreview(entry.text)}</pre>
        ) : (
          renderDisclosureTranscriptContent({
            preview: disclosurePreview ?? "",
            segments: disclosureSegments ?? [],
            variant: "thumbnail",
          })
        )}
      </summary>
      {entry.presentation === "diff" ? (
        <TranscriptEntryContent entry={entry} />
      ) : isWrite ? (
        renderDisclosureTranscriptText(formatToolTextFull(entry.text), false)
      ) : (
        renderDisclosureTranscriptContent({
          segments: disclosureSegments ?? [],
          variant: "expanded",
        })
      )}
    </details>
  );
}

const MemoizedToolTranscriptText = memo(ToolTranscriptText);

export function TranscriptEntry({ entry }: { entry: Session["messages"][number] }) {
  if (!entry.text && entry.role !== "tool") return null;

  const isCollapsibleSystem = entry.role === "system" && entry.presentation !== "diff";
  const isCollapsibleTool = entry.role === "tool";

  return (
    <article className={cn("transcript-entry", `transcript-${entry.role}`)}>
      {isCollapsibleSystem || isCollapsibleTool ? null : <TranscriptEntryHeader entry={entry} />}
      {isCollapsibleSystem ? (
        <MemoizedSystemTranscriptText entry={entry} />
      ) : isCollapsibleTool ? (
        <MemoizedToolTranscriptText entry={entry} />
      ) : (
        <TranscriptEntryContent entry={entry} />
      )}
    </article>
  );
}

export interface AskToolCallProps {
  request: AskRequest;
  connection: "connecting" | "connected" | "disconnected";
  onRespond(response: AskResponse): Promise<void>;
  onActivity(): void;
}

export function AskToolCall(props: AskToolCallProps) {
  return props.request.kind === "rich" ? <RichAskToolCall {...props} /> : <LegacyAskToolCall {...props} />;
}

function askOptionHasLinks(texts: readonly (string | undefined)[]): boolean {
  return texts.some((text) => text && tokenizeSafeHttpUrls(text).some((token) => token.kind === "link"));
}

function renderAskOptionControlCopy({
  description,
  label,
  preview,
  keyPrefix,
  recommended,
}: {
  description?: string;
  label: string;
  preview?: string;
  keyPrefix: string;
  recommended?: boolean;
}) {
  return (
    <span className="ask-option-copy">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">
        {renderSafeHttpTextWithoutLinks(label, `${keyPrefix}:label`)}
        {recommended ? <Badge>Recommended</Badge> : null}
      </span>
      {description ? (
        <span className="ask-option-description">
          {renderSafeHttpTextWithoutLinks(description, `${keyPrefix}:description`)}
        </span>
      ) : null}
      {preview ? (
        <span className="ask-option-preview">
          {renderSafeHttpTextWithoutLinks(preview, `${keyPrefix}:preview`)}
        </span>
      ) : null}
    </span>
  );
}

function renderAskOptionLinkContainer(texts: readonly (string | undefined)[], keyPrefix: string) {
  return (
    <span className="ask-option-links">
      {texts.flatMap((text, textIndex) =>
        text ? renderSafeHttpLinkSiblings(text, `${keyPrefix}:${textIndex}`) : [],
      )}
    </span>
  );
}

function LegacyAskToolCall({ request, connection, onRespond }: AskToolCallProps) {
  if (request.kind === "rich") return null;
  const [draft, setDraft] = useState(request.initialValue ?? "");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const sending = state === "sending";
  const answerId = `ask-answer-${encodeURIComponent(request.sessionId)}-${encodeURIComponent(
    request.requestId,
  )}`;

  const respond = async (response: AskResponse) => {
    if (sending) return;
    setState("sending");
    setError(null);
    try {
      await onRespond(response);
      globalThis.document?.querySelector<HTMLElement>("#composer-message")?.focus();
    } catch (responseFailure) {
      setError(
        responseFailure instanceof Error ? responseFailure.message : "Your answer could not be delivered",
      );
      setState("idle");
    }
  };

  return (
    <article
      className="transcript-entry transcript-tool transcript-ask"
      aria-busy={sending}
      aria-labelledby={`${answerId}-title`}
    >
      <header className="ask-header">
        <span className="message-author">
          <i aria-hidden="true">?</i>
          <span>ask</span>
        </span>
        <span className="ask-status">{sending ? "Sending response…" : "Waiting for your response"}</span>
      </header>
      <strong className="ask-title" id={`${answerId}-title`}>
        {renderSafeHttpText(request.title, "ask-legacy-title")}
      </strong>
      {request.kind === "select" ? (
        <>
          <div className="ask-options">
            {request.options.map((option, index) => {
              const optionKey = `${option}-${index}`;
              const respondToOption = () => void respond({ value: option });
              return askOptionHasLinks([option]) ? (
                <div className="ask-option-row" key={optionKey}>
                  <Button
                    aria-label={option}
                    className="ask-option"
                    disabled={sending || connection !== "connected"}
                    onClick={respondToOption}
                    type="button"
                    variant="outline"
                  >
                    {renderAskOptionControlCopy({
                      keyPrefix: `ask-legacy-option-${index}`,
                      label: option,
                    })}
                  </Button>
                  {renderAskOptionLinkContainer([option], `ask-legacy-option-${index}`)}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="ask-option"
                  disabled={sending || connection !== "connected"}
                  onClick={respondToOption}
                  key={optionKey}
                >
                  {renderSafeHttpText(option, `ask-legacy-option-${index}`)}
                </Button>
              );
            })}
          </div>
          <footer className="ask-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={sending}
              onClick={() => void respond({ cancelled: true })}
            >
              Cancel
            </Button>
          </footer>
        </>
      ) : (
        <form
          className="ask-answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void respond({ value: draft });
          }}
        >
          <label htmlFor={answerId}>Your answer</label>
          <Textarea
            id={answerId}
            className="ask-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending || connection !== "connected"}
            rows={5}
          />
          <footer className="ask-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={sending}
              onClick={() => void respond({ cancelled: true })}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={sending || connection !== "connected"} aria-busy={sending}>
              {sending ? "Answering…" : "Answer"}
            </Button>
          </footer>
        </form>
      )}
      {error ? (
        <p className="inline-error ask-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

type RichAnswer = {
  selectedOptions: string[];
  customInput: string;
  note: string;
};

function RichAskToolCall({ request, connection, onRespond, onActivity }: AskToolCallProps) {
  if (request.kind !== "rich") return null;
  const [answers, setAnswers] = useState<RichAnswer[]>(() =>
    request.questions.map(() => ({ selectedOptions: [], customInput: "", note: "" })),
  );
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const activeQuestionTitleRef = useRef<HTMLLegendElement | null>(null);
  const hasRenderedQuestion = useRef(false);
  const sending = state === "sending";
  const askId = `ask-answer-${encodeURIComponent(request.sessionId)}-${encodeURIComponent(request.requestId)}`;
  const questionCount = request.questions.length;
  const lastQuestionIndex = Math.max(questionCount - 1, 0);
  const boundedActiveQuestionIndex = Math.min(activeQuestionIndex, lastQuestionIndex);
  const activeQuestion = request.questions[boundedActiveQuestionIndex];
  const complete = request.questions.every(
    (_question, index) =>
      (answers[index]?.selectedOptions.length ?? 0) > 0 || Boolean(answers[index]?.customInput.trim()),
  );

  useLayoutEffect(() => {
    if (hasRenderedQuestion.current) {
      activeQuestionTitleRef.current?.focus();
    }
    hasRenderedQuestion.current = true;
  }, [request.requestId, boundedActiveQuestionIndex]);

  const updateAnswer = (index: number, update: (answer: RichAnswer) => RichAnswer) => {
    setAnswers((current) => {
      const answer = current[index];
      if (!answer) return current;
      const next = [...current];
      next[index] = update(answer);
      return next;
    });
  };

  const respond = async (response: AskResponse) => {
    if (sending) return;
    setState("sending");
    setError(null);
    try {
      await onRespond(response);
      globalThis.document?.querySelector<HTMLElement>("#composer-message")?.focus();
    } catch (responseFailure) {
      setError(
        responseFailure instanceof Error ? responseFailure.message : "Your answer could not be delivered",
      );
      setState("idle");
    }
  };

  const submit = () =>
    respond({
      kind: "submit",
      results: request.questions.map((question, index) => {
        const answer = answers[index] ?? { selectedOptions: [], customInput: "", note: "" };
        return {
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multi: question.multi ?? false,
          selectedOptions: answer.selectedOptions,
          ...(answer.customInput.trim() ? { customInput: answer.customInput } : {}),
          ...(answer.note.trim() ? { note: answer.note } : {}),
        };
      }),
    });

  return (
    <article
      className="transcript-entry transcript-tool transcript-ask ask-rich"
      aria-busy={sending}
      aria-labelledby={`${askId}-title`}
    >
      <header className="ask-header">
        <span className="message-author">
          <i aria-hidden="true">?</i>
          <span>ask</span>
        </span>
        <span className="ask-status" aria-live="polite">
          {sending ? "Sending response…" : "Waiting for your response"}
        </span>
      </header>
      <strong className="ask-title" id={`${askId}-title`}>
        {questionCount === 1 ? "One question" : `${questionCount} questions`}
      </strong>
      {questionCount > 1 ? (
        <span className="ask-progress" aria-live="polite">
          Question {boundedActiveQuestionIndex + 1} of {questionCount}
        </span>
      ) : null}
      <div className="ask-question-list">
        {activeQuestion ? (
          <fieldset className="ask-question" key={activeQuestion.id}>
            <legend
              className="ask-question-title"
              id={`${askId}-${boundedActiveQuestionIndex}-legend`}
              ref={activeQuestionTitleRef}
              tabIndex={-1}
            >
              {activeQuestion.header ? (
                <span className="ask-question-header">
                  {renderSafeHttpText(activeQuestion.header, "ask-rich-header")}
                </span>
              ) : null}
              <span>{renderSafeHttpText(activeQuestion.question, "ask-rich-question")}</span>
            </legend>
            {activeQuestion.multi ? (
              <div className="ask-options">
                {activeQuestion.options.map((option, optionIndex) => {
                  const answer = answers[boundedActiveQuestionIndex] ?? {
                    selectedOptions: [],
                    customInput: "",
                    note: "",
                  };
                  const selected = answer.selectedOptions.includes(option.label);
                  const toggleOption = () => {
                    onActivity();
                    updateAnswer(boundedActiveQuestionIndex, (current) => ({
                      ...current,
                      selectedOptions: selected
                        ? current.selectedOptions.filter((label) => label !== option.label)
                        : [...current.selectedOptions, option.label],
                    }));
                  };
                  const optionKey = `${option.label}-${optionIndex}`;
                  return askOptionHasLinks([option.label, option.description, option.preview]) ? (
                    <div className="ask-option-row" key={optionKey}>
                      <Button
                        aria-label={option.label}
                        aria-pressed={selected}
                        className="ask-option ask-rich-option"
                        disabled={sending || connection !== "connected"}
                        onClick={toggleOption}
                        type="button"
                        variant={selected ? "default" : "outline"}
                      >
                        {renderAskOptionControlCopy({
                          ...(option.description === undefined ? {} : { description: option.description }),
                          keyPrefix: `ask-rich-multi-option-${optionIndex}`,
                          label: option.label,
                          ...(option.preview === undefined ? {} : { preview: option.preview }),
                          recommended: activeQuestion.recommended === optionIndex,
                        })}
                      </Button>
                      {renderAskOptionLinkContainer(
                        [option.label, option.description, option.preview],
                        `ask-rich-multi-option-${optionIndex}`,
                      )}
                    </div>
                  ) : (
                    <Button
                      aria-pressed={selected}
                      className="ask-option ask-rich-option"
                      disabled={sending || connection !== "connected"}
                      key={optionKey}
                      onClick={toggleOption}
                      type="button"
                      variant={selected ? "default" : "outline"}
                    >
                      <span className="ask-option-copy">
                        <span>
                          {renderSafeHttpText(option.label, `ask-rich-multi-option-${optionIndex}:label`)}
                          {activeQuestion.recommended === optionIndex ? <Badge>Recommended</Badge> : null}
                        </span>
                        {option.description ? (
                          <span className="ask-option-description">
                            {renderSafeHttpText(
                              option.description,
                              `ask-rich-multi-option-${optionIndex}:description`,
                            )}
                          </span>
                        ) : null}
                        {option.preview ? (
                          <span className="ask-option-preview">
                            {renderSafeHttpText(
                              option.preview,
                              `ask-rich-multi-option-${optionIndex}:preview`,
                            )}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  );
                })}
              </div>
            ) : (
              <RadioGroup
                className="ask-options"
                aria-labelledby={`${askId}-${boundedActiveQuestionIndex}-legend`}
                name={`${askId}-${boundedActiveQuestionIndex}`}
                value={answers[boundedActiveQuestionIndex]?.selectedOptions[0] ?? ""}
                disabled={sending || connection !== "connected"}
                onValueChange={(value) => {
                  onActivity();
                  updateAnswer(boundedActiveQuestionIndex, (current) => ({
                    ...current,
                    selectedOptions: [value],
                    customInput: "",
                  }));
                }}
              >
                {activeQuestion.options.map((option, optionIndex) => {
                  const answer = answers[boundedActiveQuestionIndex] ?? {
                    selectedOptions: [],
                    customInput: "",
                    note: "",
                  };
                  const selected = answer.selectedOptions.includes(option.label);
                  const optionKey = `${option.label}-${optionIndex}`;
                  const optionHasLinks = askOptionHasLinks([
                    option.label,
                    option.description,
                    option.preview,
                  ]);
                  const radio = (
                    <Radio.Root
                      value={option.label}
                      render={
                        <button
                          aria-label={option.label}
                          type="button"
                          data-slot="button"
                          className={cn(
                            "ui-button",
                            selected ? "ui-button-default" : "ui-button-outline",
                            "ui-button-size-default",
                            "ask-option ask-rich-option",
                          )}
                        />
                      }
                      key={optionKey}
                    >
                      {renderAskOptionControlCopy({
                        ...(option.description === undefined ? {} : { description: option.description }),
                        keyPrefix: `ask-rich-radio-option-${optionIndex}`,
                        label: option.label,
                        ...(option.preview === undefined ? {} : { preview: option.preview }),
                        recommended: activeQuestion.recommended === optionIndex,
                      })}
                    </Radio.Root>
                  );
                  return optionHasLinks ? (
                    <div className="ask-option-row" key={optionKey}>
                      {radio}
                      {renderAskOptionLinkContainer(
                        [option.label, option.description, option.preview],
                        `ask-rich-radio-option-${optionIndex}`,
                      )}
                    </div>
                  ) : (
                    radio
                  );
                })}
              </RadioGroup>
            )}
            <label htmlFor={`${askId}-${boundedActiveQuestionIndex}-custom`}>Custom answer</label>
            <Textarea
              id={`${askId}-${boundedActiveQuestionIndex}-custom`}
              className="ask-textarea"
              value={answers[boundedActiveQuestionIndex]?.customInput ?? ""}
              onChange={(event) => {
                onActivity();
                updateAnswer(boundedActiveQuestionIndex, (current) => ({
                  ...current,
                  selectedOptions: activeQuestion.multi ? current.selectedOptions : [],
                  customInput: event.target.value,
                }));
              }}
              disabled={sending || connection !== "connected"}
              rows={2}
            />
            <label htmlFor={`${askId}-${boundedActiveQuestionIndex}-note`}>Note (optional)</label>
            <Textarea
              id={`${askId}-${boundedActiveQuestionIndex}-note`}
              className="ask-textarea"
              value={answers[boundedActiveQuestionIndex]?.note ?? ""}
              onChange={(event) => {
                onActivity();
                updateAnswer(boundedActiveQuestionIndex, (current) => ({
                  ...current,
                  note: event.target.value,
                }));
              }}
              disabled={sending || connection !== "connected"}
              rows={2}
            />
          </fieldset>
        ) : null}
      </div>
      <footer className="ask-actions ask-rich-actions">
        <Button
          type="button"
          variant="ghost"
          disabled={sending || connection !== "connected"}
          onClick={() => void respond({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={sending || connection !== "connected"}
          onClick={() => void respond({ kind: "chat" })}
        >
          Chat about this
        </Button>
        {questionCount > 1 ? (
          <Button
            type="button"
            variant="outline"
            disabled={boundedActiveQuestionIndex === 0 || sending || connection !== "connected"}
            onClick={() => setActiveQuestionIndex((current) => Math.max(current - 1, 0))}
          >
            Previous
          </Button>
        ) : null}
        {boundedActiveQuestionIndex < lastQuestionIndex ? (
          <Button
            type="button"
            disabled={sending || connection !== "connected"}
            onClick={() => setActiveQuestionIndex((current) => Math.min(current + 1, lastQuestionIndex))}
          >
            Next
          </Button>
        ) : (
          <Button
            type="button"
            disabled={sending || connection !== "connected" || !complete}
            onClick={() => void submit()}
          >
            Submit answers
          </Button>
        )}
      </footer>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function DashboardContent({
  sessionsReady,
  sessions,
  askRequests,
  savedWorkingDirectories,
  historyLoading,
  hasMoreHistory,
  connection,
  error,
  notificationState,
  selectedSessionId,
  onSelectedSessionChange,
  onEnableNotifications,
  onLaunch,
  onSaveWorkingDirectory,
  onRemoveWorkingDirectory,
  onCommand,
  onAbort,
  onKill,
  onSetModel,
  onSetEffort,
  onRespondToAsk,
  onAskActivity,
  onSearchHistory,
  onLoadMoreHistory,
  onLoadTranscript,
  onLoadSessionFileChanges,
  onLoadSessionBranchTopology,
  onSwitchBranch,
}: DashboardProps) {
  const [viewedSubagent, setViewedSubagent] = useState<ActiveSubagent | null>(null);
  const [message, setMessage] = useState("");
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [autocompleteDismissedFor, setAutocompleteDismissedFor] = useState<string | null>(null);
  const [commandState, setCommandState] = useState<"idle" | "sending">("idle");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState("");
  const [launchState, setLaunchState] = useState<"idle" | "sending">("idle");
  const [savedDirectoryPending, setSavedDirectoryPending] = useState<{
    action: "save" | "remove";
    cwd: string;
  } | null>(null);
  const [savedDirectoryError, setSavedDirectoryError] = useState<string | null>(null);
  const [abortOpen, setAbortOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [todoOpenSessionId, setTodoOpenSessionId] = useState<string | null>(null);
  const [configurationDrawer, setConfigurationDrawer] = useState<"model" | "effort" | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [configurationPending, setConfigurationPending] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<{
    drawer: "model" | "effort";
    message: string;
  } | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [activeHistoryQuery, setActiveHistoryQuery] = useState("");
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);
  const loadedTranscriptIdRef = useRef<string | null>(null);
  const transcriptScrollToEndRef = useRef<(() => void) | null>(null);
  const registerTranscriptScrollToEnd = useCallback((handler: (() => void) | null) => {
    transcriptScrollToEndRef.current = handler;
  }, []);
  const configurationRequestRef = useRef<{ sessionId: string } | null>(null);
  const configurationSessionIdRef = useRef<string | null>(null);
  const [fileChangesOpen, setFileChangesOpen] = useState(false);
  const [sessionFileChanges, setSessionFileChanges] = useState<SessionFileChangesResponse | null>(null);
  const [sessionFileChangesLoading, setSessionFileChangesLoading] = useState(false);
  const [sessionFileChangesError, setSessionFileChangesError] = useState<string | null>(null);
  const [sessionFileChangesSessionId, setSessionFileChangesSessionId] = useState<string | null>(null);
  const fileChangesRequestRef = useRef(0);
  const fileChangesAbortRef = useRef<AbortController | null>(null);
  const fileChangesOpenRef = useRef(false);
  const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);
  const [branchTopology, setBranchTopology] = useState<SessionBranchTopology | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchTopologyLoading, setBranchTopologyLoading] = useState(false);
  const [branchTopologyError, setBranchTopologyError] = useState<string | null>(null);
  const [branchCheckoutPending, setBranchCheckoutPending] = useState<string | null>(null);
  const [branchCheckoutError, setBranchCheckoutError] = useState<string | null>(null);
  const branchRequestGenerationRef = useRef(0);
  const branchSelectorSessionIdRef = useRef<string | null>(null);
  const branchLoadAbortRef = useRef<AbortController | null>(null);
  const fileChangesRefreshTimerRef = useRef<number | null>(null);
  const { isMobile, setOpenMobile } = useSidebar();

  const mainSessions = useMemo(() => filterMainSessions(sessions), [sessions]);
  const sessionSections = useMemo(() => groupSessionsForSidebar(mainSessions), [mainSessions]);
  const selectedSession = useMemo(
    () =>
      mainSessions.find((session) => session.id === selectedSessionId) ??
      sessionSections[0]?.sessions[0] ??
      null,
    [mainSessions, selectedSessionId, sessionSections],
  );
  const canSwitchSelectedSessionBranch =
    selectedSession !== null &&
    selectedSession.branch !== null &&
    selectedSession.source !== "history" &&
    selectedSession.connected &&
    connection === "connected" &&
    (selectedSession.status === "idle" || selectedSession.status === "waiting");
  const resetBranchSelector = useCallback(() => {
    branchRequestGenerationRef.current += 1;
    branchLoadAbortRef.current?.abort();
    branchLoadAbortRef.current = null;
    branchSelectorSessionIdRef.current = null;
    setBranchSelectorOpen(false);
    setBranchTopology(null);
    setBranchQuery("");
    setBranchTopologyLoading(false);
    setBranchTopologyError(null);
    setBranchCheckoutPending(null);
    setBranchCheckoutError(null);
  }, []);
  const handleBranchSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (branchCheckoutPending !== null) return;
        resetBranchSelector();
        return;
      }
      if (!selectedSession || !canSwitchSelectedSessionBranch) return;
      if (branchSelectorSessionIdRef.current === selectedSession.id) return;

      branchLoadAbortRef.current?.abort();
      const abortController = new AbortController();
      const generation = ++branchRequestGenerationRef.current;
      const sessionId = selectedSession.id;
      branchLoadAbortRef.current = abortController;
      branchSelectorSessionIdRef.current = sessionId;
      setBranchSelectorOpen(true);
      setBranchTopology(null);
      setBranchQuery("");
      setBranchTopologyLoading(true);
      setBranchTopologyError(null);
      setBranchCheckoutPending(null);
      setBranchCheckoutError(null);

      void onLoadSessionBranchTopology(sessionId, abortController.signal)
        .then((topology) => {
          if (
            generation !== branchRequestGenerationRef.current ||
            abortController.signal.aborted ||
            branchSelectorSessionIdRef.current !== sessionId ||
            topology.sessionId !== sessionId
          )
            return;
          setBranchTopology(topology);
        })
        .catch((failure: unknown) => {
          if (
            generation !== branchRequestGenerationRef.current ||
            abortController.signal.aborted ||
            branchSelectorSessionIdRef.current !== sessionId
          )
            return;
          setBranchTopologyError(
            failure instanceof Error ? failure.message : "Local branch topology could not be loaded.",
          );
        })
        .finally(() => {
          if (
            generation === branchRequestGenerationRef.current &&
            branchSelectorSessionIdRef.current === sessionId
          ) {
            setBranchTopologyLoading(false);
            if (branchLoadAbortRef.current === abortController) branchLoadAbortRef.current = null;
          }
        });
    },
    [
      branchCheckoutPending,
      canSwitchSelectedSessionBranch,
      onLoadSessionBranchTopology,
      resetBranchSelector,
      selectedSession,
    ],
  );
  const clearSessionFileChangesRefreshTimer = useCallback(() => {
    if (fileChangesRefreshTimerRef.current === null) return;
    globalThis.clearTimeout(fileChangesRefreshTimerRef.current);
    fileChangesRefreshTimerRef.current = null;
  }, []);
  const refreshSessionFileChanges = useCallback(
    async (sessionId: string) => {
      const requestNumber = ++fileChangesRequestRef.current;
      fileChangesAbortRef.current?.abort();
      const abortController = new AbortController();
      fileChangesAbortRef.current = abortController;
      setSessionFileChangesSessionId(sessionId);
      setSessionFileChangesLoading(true);
      setSessionFileChangesError(null);
      try {
        const result = await onLoadSessionFileChanges(sessionId, abortController.signal);
        if (requestNumber !== fileChangesRequestRef.current || abortController.signal.aborted) return;
        setSessionFileChanges(result);
      } catch (failure) {
        if (requestNumber !== fileChangesRequestRef.current || abortController.signal.aborted) return;
        setSessionFileChanges(null);
        setSessionFileChangesError(
          failure instanceof Error ? failure.message : "Session file changes could not be loaded.",
        );
      } finally {
        if (requestNumber === fileChangesRequestRef.current) {
          setSessionFileChangesLoading(false);
          if (fileChangesAbortRef.current === abortController) fileChangesAbortRef.current = null;
        }
      }
    },
    [onLoadSessionFileChanges],
  );
  const handleFileChangesOpenChange = useCallback(
    (open: boolean) => {
      clearSessionFileChangesRefreshTimer();
      fileChangesOpenRef.current = open;
      setFileChangesOpen(open);
      if (!open) {
        fileChangesRequestRef.current += 1;
        fileChangesAbortRef.current?.abort();
        fileChangesAbortRef.current = null;
        setSessionFileChangesLoading(false);
        return;
      }
      if (selectedSession?.id) void refreshSessionFileChanges(selectedSession.id);
    },
    [clearSessionFileChangesRefreshTimer, refreshSessionFileChanges, selectedSession?.id],
  );
  const askingSessionIds = useMemo(
    () => new Set(askRequests.map((request) => request.sessionId)),
    [askRequests],
  );
  const activeAskRequest = getActiveAskRequest(askRequests, selectedSession?.id ?? null);
  const selectedSessionStatus =
    selectedSession && askingSessionIds.has(selectedSession.id) ? "waiting" : selectedSession?.status;
  const currentTodo = useMemo(
    () => (selectedSession ? findLatestTodoResult(selectedSession.messages) : null),
    [selectedSession?.messages],
  );
  const currentTodoPresentation = currentTodo ? getTodoPresentation(currentTodo) : null;
  const composerAction = selectedSession ? getComposerAction(selectedSession, message) : null;
  const skillSuggestions = useMemo(
    () => getSkillSuggestions(message, selectedSession?.skillCommands ?? []),
    [message, selectedSession?.skillCommands],
  );
  const visibleSkillSuggestions = autocompleteDismissedFor === message ? [] : skillSuggestions;
  const activeSkillSuggestion = visibleSkillSuggestions[activeSkillIndex] ?? visibleSkillSuggestions[0];
  const viewedSubagentSession = useMemo(
    () => sessions.find((session) => session.id === viewedSubagent?.id) ?? null,
    [sessions, viewedSubagent?.id],
  );
  const availableModels = selectedSession?.availableModels ?? EMPTY_MODEL_OPTIONS;
  const currentModelOption = availableModels.find(
    (model) => `${model.provider}/${model.id}` === selectedSession?.model,
  );
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((model) =>
      [model.name, model.provider, model.id].some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [availableModels, modelQuery]);
  const availableEfforts = currentModelOption?.efforts ?? [];
  const sessionFileChangesMatchesSelection =
    selectedSession !== null && sessionFileChangesSessionId === selectedSession.id;
  const visibleSessionFileChanges = sessionFileChangesMatchesSelection ? sessionFileChanges : null;
  const visibleSessionFileChangesError = sessionFileChangesMatchesSelection ? sessionFileChangesError : null;
  const visibleSessionFileChangesLoading =
    sessionFileChangesLoading ||
    (fileChangesOpen && selectedSession !== null && !sessionFileChangesMatchesSelection);
  const sessionFileChangesMetadata = useMemo(
    () =>
      formatSessionFileChangesMetadata(
        visibleSessionFileChanges,
        visibleSessionFileChangesError,
        visibleSessionFileChangesLoading,
      ),
    [visibleSessionFileChanges, visibleSessionFileChangesError, visibleSessionFileChangesLoading],
  );

  useEffect(() => {
    setActiveSkillIndex(0);
    setAutocompleteDismissedFor(null);
  }, [message, selectedSession?.id]);

  useEffect(() => {
    if (sessionsReady && selectedSession && selectedSession.id !== selectedSessionId) {
      onSelectedSessionChange(selectedSession.id);
    }
  }, [onSelectedSessionChange, selectedSession, selectedSessionId, sessionsReady]);

  useEffect(() => {
    setViewedSubagent(null);
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    if (todoOpenSessionId !== null && (todoOpenSessionId !== selectedSession?.id || currentTodo === null)) {
      setTodoOpenSessionId(null);
    }
  }, [currentTodo, selectedSession?.id, todoOpenSessionId]);

  useLayoutEffect(() => {
    configurationSessionIdRef.current = selectedSession?.id ?? null;
    configurationRequestRef.current = null;
    setConfigurationDrawer(null);
    setModelQuery("");
    setConfigurationPending(null);
    setConfigurationError(null);
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    if (branchSelectorSessionIdRef.current === null) return;
    const invalidSession =
      !selectedSession ||
      branchSelectorSessionIdRef.current !== selectedSession.id ||
      selectedSession.branch === null ||
      selectedSession.source === "history" ||
      !selectedSession.connected ||
      connection !== "connected" ||
      selectedSession.status === "disconnected" ||
      selectedSession.status === "history" ||
      (branchTopology !== null && selectedSession.branch !== branchTopology.currentBranch);
    if (invalidSession) resetBranchSelector();
  }, [
    connection,
    branchTopology?.currentBranch,
    resetBranchSelector,
    selectedSession?.branch,
    selectedSession?.connected,
    selectedSession?.id,
    selectedSession?.source,
    selectedSession?.status,
  ]);

  useEffect(
    () => () => {
      branchRequestGenerationRef.current += 1;
      branchLoadAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    clearSessionFileChangesRefreshTimer();
    const sessionId = selectedSession?.id;
    if (!sessionId) {
      fileChangesRequestRef.current += 1;
      fileChangesAbortRef.current?.abort();
      fileChangesAbortRef.current = null;
      fileChangesOpenRef.current = false;
      setSessionFileChangesSessionId(null);
      setSessionFileChanges(null);
      setSessionFileChangesError(null);
      setSessionFileChangesLoading(false);
      setFileChangesOpen(false);
      return;
    }
    const refreshGeneration = ++fileChangesRequestRef.current;
    fileChangesAbortRef.current?.abort();
    fileChangesAbortRef.current = null;
    setSessionFileChangesSessionId(sessionId);
    setSessionFileChanges((current) => (current?.sessionId === sessionId ? current : null));
    setSessionFileChangesError(null);
    if (!fileChangesOpenRef.current) {
      setSessionFileChangesLoading(false);
      return;
    }
    setSessionFileChangesLoading(true);
    fileChangesRefreshTimerRef.current = globalThis.setTimeout(() => {
      fileChangesRefreshTimerRef.current = null;
      if (!fileChangesOpenRef.current || fileChangesRequestRef.current !== refreshGeneration) return;
      void refreshSessionFileChanges(sessionId);
    }, 750);
    return clearSessionFileChangesRefreshTimer;
  }, [
    clearSessionFileChangesRefreshTimer,
    refreshSessionFileChanges,
    selectedSession?.id,
    selectedSession?.lastActivity,
  ]);

  useEffect(
    () => () => {
      clearSessionFileChangesRefreshTimer();
      fileChangesRequestRef.current += 1;
      fileChangesAbortRef.current?.abort();
    },
    [clearSessionFileChangesRefreshTimer],
  );

  useEffect(() => {
    if (selectedSession?.source !== "history" || loadedTranscriptIdRef.current === selectedSession.id) return;
    const sessionId = selectedSession.id;
    loadedTranscriptIdRef.current = sessionId;
    setTranscriptLoadingId(sessionId);
    void onLoadTranscript(sessionId)
      .catch(() => {
        if (loadedTranscriptIdRef.current === sessionId) loadedTranscriptIdRef.current = null;
      })
      .finally(() => setTranscriptLoadingId((current) => (current === sessionId ? null : current)));
  }, [onLoadTranscript, selectedSession]);

  const selectSkillSuggestion = (commandName: string) => {
    setMessage(`/${commandName} `);
  };

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSession || !composerAction || commandState === "sending") return;
    if (composerAction === "abort") {
      setAbortOpen(true);
      return;
    }
    setCommandState("sending");
    setCommandError(null);
    try {
      await onCommand(selectedSession.id, "steer", message.trim());
      transcriptScrollToEndRef.current?.();
      setMessage("");
    } catch (commandFailure) {
      setCommandError(
        commandFailure instanceof Error ? commandFailure.message : "The instruction could not be sent",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const submitLaunch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (launchState === "sending") return;
    const formElement = event.currentTarget;
    const cwd = launchCwd.trim();
    const resume = String(new FormData(formElement).get("resume") ?? "").trim();
    if (!cwd) return;
    setLaunchState("sending");
    setLaunchError(null);
    try {
      const sessionId = await onLaunch(cwd, resume || null);
      onSelectedSessionChange(sessionId);
      setLaunchOpen(false);
      setLaunchCwd("");
      formElement.reset();
    } catch (launchFailure) {
      setLaunchError(
        launchFailure instanceof Error ? launchFailure.message : "OMP could not start the session",
      );
    } finally {
      setLaunchState("idle");
    }
  };

  const saveWorkingDirectory = async () => {
    const cwd = launchCwd.trim();
    if (!cwd || savedDirectoryPending) return;
    setSavedDirectoryPending({ action: "save", cwd });
    setSavedDirectoryError(null);
    try {
      await onSaveWorkingDirectory(cwd);
    } catch (saveFailure) {
      setSavedDirectoryError(
        saveFailure instanceof Error ? saveFailure.message : "The working directory could not be saved",
      );
    } finally {
      setSavedDirectoryPending(null);
    }
  };

  const removeWorkingDirectory = async (cwd: string) => {
    if (savedDirectoryPending) return;
    setSavedDirectoryPending({ action: "remove", cwd });
    setSavedDirectoryError(null);
    try {
      await onRemoveWorkingDirectory(cwd);
    } catch (removeFailure) {
      setSavedDirectoryError(
        removeFailure instanceof Error
          ? removeFailure.message
          : "The saved working directory could not be removed",
      );
    } finally {
      setSavedDirectoryPending(null);
    }
  };

  const submitHistorySearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = historyQuery.trim();
    try {
      await onSearchHistory(query);
      setActiveHistoryQuery(query);
    } catch {
      // The shared client exposes the actionable request error above the session list.
    }
  };

  const resumeSelectedSession = async () => {
    if (!selectedSession?.sessionPath || commandState === "sending") return;
    setCommandState("sending");
    setCommandError(null);
    try {
      const sessionId = await onLaunch(selectedSession.cwd, selectedSession.sessionPath);
      onSelectedSessionChange(sessionId);
    } catch (resumeFailure) {
      setCommandError(
        resumeFailure instanceof Error ? resumeFailure.message : "The session could not be resumed",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const abortSelectedSession = async () => {
    if (!selectedSession) return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onAbort(selectedSession.id);
      setAbortOpen(false);
    } catch (abortFailure) {
      setCommandError(
        abortFailure instanceof Error ? abortFailure.message : "The active run could not be interrupted",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const killSelectedSession = async () => {
    if (!selectedSession) return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onKill(selectedSession.id);
      setKillOpen(false);
    } catch (killFailure) {
      setCommandError(
        killFailure instanceof Error ? killFailure.message : "The session process could not be terminated",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const selectModel = async (model: string) => {
    if (
      !selectedSession ||
      configurationPending ||
      !selectedSession.capabilities.includes("model") ||
      !availableModels.some((option) => `${option.provider}/${option.id}` === model)
    )
      return;
    const request = { sessionId: selectedSession.id };
    configurationRequestRef.current = request;
    setConfigurationPending(model);
    setConfigurationError(null);
    try {
      await onSetModel(selectedSession.id, model);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        drawer: "model",
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The model could not be changed",
      });
    } finally {
      if (
        configurationRequestRef.current === request &&
        configurationSessionIdRef.current === request.sessionId
      ) {
        configurationRequestRef.current = null;
        setConfigurationPending(null);
      }
    }
  };

  const selectEffort = async (effort: Effort) => {
    if (
      !selectedSession ||
      configurationPending ||
      !selectedSession.capabilities.includes("effort") ||
      !currentModelOption?.efforts.includes(effort)
    )
      return;
    const request = { sessionId: selectedSession.id };
    configurationRequestRef.current = request;
    setConfigurationPending(effort);
    setConfigurationError(null);
    try {
      await onSetEffort(selectedSession.id, effort);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        drawer: "effort",
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The effort could not be changed",
      });
    } finally {
      if (
        configurationRequestRef.current === request &&
        configurationSessionIdRef.current === request.sessionId
      ) {
        configurationRequestRef.current = null;
        setConfigurationPending(null);
      }
    }
  };

  const selectBranch = async (branch: string) => {
    if (
      !selectedSession ||
      !canSwitchSelectedSessionBranch ||
      branchCheckoutPending !== null ||
      !branchTopology?.branches.some((candidate) => candidate.name === branch) ||
      branch === branchTopology.currentBranch
    )
      return;
    const generation = branchRequestGenerationRef.current;
    const sessionId = selectedSession.id;
    setBranchCheckoutPending(branch);
    setBranchCheckoutError(null);
    try {
      await onSwitchBranch(sessionId, branch);
      if (
        generation !== branchRequestGenerationRef.current ||
        branchSelectorSessionIdRef.current !== sessionId
      )
        return;
      resetBranchSelector();
    } catch (failure) {
      if (
        generation !== branchRequestGenerationRef.current ||
        branchSelectorSessionIdRef.current !== sessionId
      )
        return;
      setBranchCheckoutPending(null);
      setBranchCheckoutError(failure instanceof Error ? failure.message : "Branch checkout failed.");
    }
  };

  return (
    <div className="app-shell">
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              π
            </span>
            <span className="brand-word">omp</span>
            <span className="brand-remote">remote</span>
          </div>
          <SidebarTrigger />
        </SidebarHeader>

        <div className="sidebar-actions">
          <Button type="button" onClick={() => setLaunchOpen(true)} className="new-session-button">
            <Icon name="plus" />
            <span>New session</span>
          </Button>
          <form className="session-search" onSubmit={submitHistorySearch}>
            <div className="session-search-field">
              <label className="sr-only" htmlFor="session-search-input">
                Search all local OMP sessions
              </label>
              <Icon name="search" />
              <Input
                id="session-search-input"
                type="search"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="Search sessions"
                maxLength={200}
              />
            </div>
          </form>
        </div>

        <SidebarContent>
          <nav className="session-list" aria-label="Registered OMP sessions">
            {mainSessions.length === 0 ? (
              <div className="sidebar-empty" role="status">
                <span className="status-orbit" aria-hidden="true" />
                <strong>{historyLoading ? "Reading session history" : "No sessions found"}</strong>
                <p>
                  {activeHistoryQuery
                    ? "Try another name, ID, or working directory."
                    : "Start a session here or connect a terminal session."}
                </p>
                {!historyLoading ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (activeHistoryQuery) {
                        setHistoryQuery("");
                        setActiveHistoryQuery("");
                        void onSearchHistory("").catch(() => undefined);
                      } else {
                        setLaunchOpen(true);
                      }
                    }}
                  >
                    {activeHistoryQuery ? "Clear search" : "Start session"}
                  </Button>
                ) : null}
              </div>
            ) : (
              sessionSections.map((section) => (
                <section
                  className="session-group"
                  aria-labelledby={`session-group-${section.id}`}
                  key={section.id}
                >
                  <h2 className="session-group-heading" id={`session-group-${section.id}`}>
                    <span>{section.label}</span>
                    {section.id !== "disconnected" ? (
                      <span>
                        {section.sessions.length.toLocaleString()}
                        <span className="sr-only">
                          {" "}
                          {section.sessions.length === 1 ? "session" : "sessions"}
                        </span>
                      </span>
                    ) : null}
                  </h2>
                  {section.sessions.map((session) => {
                    const selected = session.id === selectedSession?.id;
                    const displayName =
                      session.name ?? session.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled session";
                    const displayStatus = askingSessionIds.has(session.id) ? "waiting" : session.status;
                    return (
                      <button
                        className={cn("session-item", selected && "session-item-selected")}
                        type="button"
                        key={session.id}
                        aria-current={selected ? "page" : undefined}
                        aria-label={`${displayName}, ${SESSION_STATUS_LABEL[displayStatus]}`}
                        title={displayName}
                        onClick={() => {
                          onSelectedSessionChange(session.id);
                          setViewedSubagent(null);
                          setOpenMobile(false);
                        }}
                      >
                        <span
                          className={cn(
                            "session-state-dot",
                            `session-state-${SESSION_STATUS_TONE[displayStatus]}`,
                          )}
                        />
                        <span className="session-copy">
                          <strong>{displayName}</strong>
                          <small>{compactPath(session.cwd)}</small>
                        </span>
                        <time dateTime={session.lastActivity}>{formatTime(session.lastActivity)}</time>
                      </button>
                    );
                  })}
                </section>
              ))
            )}
          </nav>
          {hasMoreHistory ? (
            <Button
              className="load-more-button"
              type="button"
              variant="ghost"
              size="sm"
              disabled={historyLoading}
              onClick={() => void onLoadMoreHistory().catch(() => undefined)}
            >
              {historyLoading ? "Reading history…" : "Load older sessions"}
            </Button>
          ) : null}
        </SidebarContent>

        <SidebarFooter>
          <span className={cn("connection-dot", `connection-${connection}`)} aria-hidden="true" />
          <span>
            {connection === "connected"
              ? "Host connected"
              : connection === "connecting"
                ? "Connecting"
                : "Host offline"}
          </span>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="session-header">
          <div className="session-header-primary">
            <SidebarTrigger />
            {selectedSession && selectedSessionStatus ? (
              <>
                <div>
                  <h1>{selectedSession.name ?? "Untitled session"}</h1>
                  <p>{selectedSession.cwd}</p>
                </div>
                <Badge className={cn("status-badge", `status-${SESSION_STATUS_TONE[selectedSessionStatus]}`)}>
                  <span aria-hidden="true" />
                  {SESSION_STATUS_LABEL[selectedSessionStatus]}
                </Badge>
                {canKillSession(selectedSession) ? (
                  <Button
                    className="kill-session-button"
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Kill ${selectedSession.name ?? "session"}`}
                    title="Kill session"
                    onClick={() => {
                      setCommandError(null);
                      setKillOpen(true);
                    }}
                  >
                    <Icon name="power" />
                  </Button>
                ) : null}
              </>
            ) : (
              <h1>OMP Remote</h1>
            )}
            {notificationState !== "unsupported" ? (
              <Button
                className="notification-button"
                type="button"
                variant="ghost"
                size="icon"
                aria-label={NOTIFICATION_CONTROL[notificationState].label}
                title={NOTIFICATION_CONTROL[notificationState].label}
                data-state={notificationState}
                disabled={NOTIFICATION_CONTROL[notificationState].disabled}
                onClick={() => void onEnableNotifications()}
              >
                <Icon name="bell" />
              </Button>
            ) : null}
          </div>
          <Button type="button" variant="outline" onClick={() => setLaunchOpen(true)}>
            <Icon name="plus" />
            New session
          </Button>
        </header>

        {error ? (
          <div className="system-alert" role="alert">
            <strong>Live connection needs attention.</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {selectedSession ? (
          <section
            className="session-workspace"
            aria-label={`Controls for ${selectedSession.name ?? selectedSession.cwd}`}
          >
            <MessageScrollerProvider
              key={selectedSession.id}
              autoScroll
              defaultScrollPosition="end"
              scrollEdgeThreshold={80}
            >
              <MessageScroller className="transcript-region">
                <MessageScrollerViewport className="transcript" aria-label="Session transcript">
                  <MessageScrollerContent
                    className="transcript-messages"
                    role="log"
                    aria-live="polite"
                    aria-busy={selectedSession.messages.at(-1)?.streaming === true}
                  >
                    {transcriptLoadingId === selectedSession.id ? (
                      <MessageScrollerItem messageId={`transcript-loading:${selectedSession.id}`}>
                        <div className="empty-transcript" role="status">
                          <span className="status-orbit" aria-hidden="true" />
                          <strong>Reading session transcript</strong>
                          <p>Large transcripts stay on the host and load only when selected.</p>
                        </div>
                      </MessageScrollerItem>
                    ) : selectedSession.messages.length === 0 && !activeAskRequest ? (
                      <MessageScrollerItem messageId={`transcript-empty:${selectedSession.id}`}>
                        <div className="empty-transcript">
                          <span className="terminal-prompt" aria-hidden="true">
                            π
                          </span>
                          <strong>
                            {selectedSession.source === "history"
                              ? "No text messages in this session"
                              : "Ready for an instruction"}
                          </strong>
                          <p>
                            {selectedSession.source === "history"
                              ? "Resume the session to continue working."
                              : "Prompt OMP below. Live output will appear here as it arrives."}
                          </p>
                        </div>
                      </MessageScrollerItem>
                    ) : (
                      renderTranscriptMessageItems({
                        messages: selectedSession.messages,
                      })
                    )}
                    {activeAskRequest ? (
                      <MessageScrollerItem
                        key={`${activeAskRequest.sessionId}:${activeAskRequest.requestId}`}
                        messageId={`ask:${activeAskRequest.sessionId}:${activeAskRequest.requestId}`}
                      >
                        <AskToolCall
                          request={activeAskRequest}
                          connection={connection}
                          onRespond={(response) =>
                            onRespondToAsk(activeAskRequest.sessionId, activeAskRequest.requestId, response)
                          }
                          onActivity={() =>
                            void onAskActivity(activeAskRequest.sessionId, activeAskRequest.requestId)
                          }
                        />
                      </MessageScrollerItem>
                    ) : null}
                    {selectedSession.status === "running" ? (
                      <MessageScrollerItem messageId={`working:${selectedSession.id}`}>
                        <WorkingIndicator status={selectedSession.status} />
                      </MessageScrollerItem>
                    ) : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton
                  className="scroll-to-bottom-button"
                  aria-label="Scroll to latest output"
                  title="Scroll to latest output"
                >
                  <Icon name="down" />
                </MessageScrollerButton>
              </MessageScroller>
              <MessageScrollerScrollController onScrollToEnd={registerTranscriptScrollToEnd} />
            </MessageScrollerProvider>
            {selectedSession.activeSubagents.length > 0 ? (
              <section className="subagent-activity" aria-label="Active subagents" aria-live="polite">
                <strong className="subagent-activity-heading">
                  {formatSubagentActivityLabel(selectedSession.activeSubagents.length)}
                </strong>
                <ul className="subagent-list">
                  {selectedSession.activeSubagents.slice(0, 5).map((subagent) => (
                    <li key={subagent.id}>
                      <button
                        type="button"
                        aria-label={`Open ${subagent.name} session`}
                        onClick={() => setViewedSubagent(subagent)}
                      >
                        <span>{subagent.name}</span>
                        <time dateTime={subagent.lastActivity}>{formatTime(subagent.lastActivity)}</time>
                      </button>
                    </li>
                  ))}
                  {selectedSession.activeSubagents.length > 5 ? (
                    <li className="subagent-overflow">
                      <span>+{selectedSession.activeSubagents.length - 5} more</span>
                    </li>
                  ) : null}
                </ul>
              </section>
            ) : null}

            <dl className="session-metadata">
              {selectedSession.branch ? (
                <div className="session-branch-metadata">
                  <dt>Branch</dt>
                  <dd>
                    {canSwitchSelectedSessionBranch ? (
                      <Button
                        className="session-branch-trigger"
                        type="button"
                        variant="ghost"
                        aria-label={`Switch branch. Current branch ${selectedSession.branch}`}
                        onClick={() => handleBranchSelectorOpenChange(true)}
                      >
                        <span className="session-branch-value" title={selectedSession.branch}>
                          {selectedSession.branch}
                        </span>
                        <Icon name="up" />
                      </Button>
                    ) : (
                      <span className="session-branch-value" title={selectedSession.branch}>
                        {selectedSession.branch}
                      </span>
                    )}
                  </dd>
                </div>
              ) : null}
              <div className="session-configuration-metadata">
                <dt>Model</dt>
                <dd>
                  <Button
                    className="session-configuration-trigger"
                    type="button"
                    variant="ghost"
                    aria-label={`Change model. Current model ${currentModelOption?.name ?? selectedSession.model ?? "Default"}`}
                    onClick={() => {
                      if (!configurationPending) setConfigurationDrawer("model");
                    }}
                  >
                    <span className="session-configuration-value">
                      {currentModelOption?.name ?? selectedSession.model?.split("/").at(-1) ?? "Default"}
                    </span>
                    <Icon name="up" />
                  </Button>
                </dd>
              </div>
              <div className="session-configuration-metadata">
                <dt>Effort</dt>
                <dd>
                  <Button
                    className="session-configuration-trigger"
                    type="button"
                    variant="ghost"
                    aria-label={`Change effort. Current effort ${formatEffortLabel(selectedSession.effort)}`}
                    onClick={() => {
                      if (!configurationPending) setConfigurationDrawer("effort");
                    }}
                  >
                    <span className="session-configuration-value">
                      {formatEffortLabel(selectedSession.effort)}
                    </span>
                    <Icon name="up" />
                  </Button>
                </dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>
                  {selectedSession.contextPercent === null
                    ? "—"
                    : `${Math.round(selectedSession.contextPercent)}%`}
                </dd>
              </div>
              <div className="session-changes-metadata">
                <dt>Changes</dt>
                <dd>
                  <Button
                    className="session-changes-trigger"
                    type="button"
                    variant="ghost"
                    aria-label={`Open session file changes. ${sessionFileChangesMetadata}`}
                    onClick={() => handleFileChangesOpenChange(true)}
                  >
                    {sessionFileChangesMetadata}
                  </Button>
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={selectedSession.lastActivity}>
                    {formatTime(selectedSession.lastActivity)}
                  </time>
                </dd>
              </div>
              {currentTodo && currentTodoPresentation ? (
                <div className="todo-tracker-metadata">
                  <dt>Todo</dt>
                  <dd>
                    <Button
                      className="todo-tracker-trigger"
                      type="button"
                      variant="ghost"
                      aria-label={getTodoTrackerLabel(currentTodo)}
                      onClick={() => setTodoOpenSessionId(selectedSession.id)}
                    >
                      <span className="todo-tracker-copy">
                        <strong>
                          {currentTodo.overall.done}/{currentTodo.overall.total}
                        </strong>
                        <span className="todo-tracker-active">
                          <span
                            aria-hidden="true"
                            className="todo-state-marker"
                            data-state={currentTodoPresentation.activeState}
                          />
                          <span>{currentTodoPresentation.activeLabel}</span>
                        </span>
                      </span>
                      <progress
                        aria-label={`Current Todo progress: ${currentTodo.overall.done} of ${
                          currentTodo.overall.total
                        } tasks ${currentTodoPresentation.progressVerb}`}
                        max={currentTodo.overall.total}
                        value={currentTodo.overall.done}
                      />
                    </Button>
                  </dd>
                </div>
              ) : null}
            </dl>

            {selectedSession.source === "history" ? (
              <div className="history-controls">
                <div>
                  <strong>Saved session</strong>
                  <span>Resume this transcript to send new instructions.</span>
                </div>
                <Button
                  type="button"
                  disabled={connection !== "connected" || commandState === "sending"}
                  onClick={() => void resumeSelectedSession()}
                >
                  Resume session
                </Button>
              </div>
            ) : (
              <form className="composer" onSubmit={submitMessage}>
                <div className="composer-field">
                  <label className="sr-only" htmlFor="composer-message">
                    Steer current run
                  </label>
                  {visibleSkillSuggestions.length > 0 ? (
                    <div
                      className="skill-suggestions"
                      id={SKILL_SUGGESTION_LIST_ID}
                      role="listbox"
                      aria-label="Available skills"
                    >
                      {visibleSkillSuggestions.map((skill, index) => (
                        <button
                          type="button"
                          className={cn("skill-suggestion", index === activeSkillIndex && "active")}
                          id={`${SKILL_SUGGESTION_LIST_ID}-${index}`}
                          role="option"
                          aria-selected={index === activeSkillIndex}
                          key={skill.name}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            selectSkillSuggestion(skill.name);
                            event.currentTarget.form?.querySelector("textarea")?.focus();
                          }}
                        >
                          <code>/{skill.name}</code>
                          {skill.description ? <span>{skill.description}</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <Textarea
                    id="composer-message"
                    value={message}
                    aria-autocomplete="list"
                    aria-controls={visibleSkillSuggestions.length > 0 ? SKILL_SUGGESTION_LIST_ID : undefined}
                    aria-expanded={visibleSkillSuggestions.length > 0}
                    aria-activedescendant={
                      activeSkillSuggestion
                        ? `${SKILL_SUGGESTION_LIST_ID}-${visibleSkillSuggestions.indexOf(activeSkillSuggestion)}`
                        : undefined
                    }
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Redirect the current run…"
                    rows={1}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter" && event.shiftKey) return;
                      if (visibleSkillSuggestions.length > 0) {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          const direction = event.key === "ArrowDown" ? 1 : -1;
                          setActiveSkillIndex(
                            (current) =>
                              (current + direction + visibleSkillSuggestions.length) %
                              visibleSkillSuggestions.length,
                          );
                        } else if (
                          (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
                          event.key === "Tab"
                        ) {
                          event.preventDefault();
                          if (activeSkillSuggestion) selectSkillSuggestion(activeSkillSuggestion.name);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setAutocompleteDismissedFor(message);
                        }
                        return;
                      }
                      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <Button
                    className="send-button"
                    type="submit"
                    size="icon"
                    variant={composerAction === "abort" ? "destructive" : "default"}
                    disabled={!composerAction || commandState === "sending"}
                    aria-label={
                      commandState === "sending"
                        ? "Sending instruction"
                        : composerAction === "abort"
                          ? "Abort active run"
                          : composerAction === "steer"
                            ? "Steer active run"
                            : "Enter an instruction to steer"
                    }
                  >
                    <Icon name={composerAction === "abort" ? "stop" : "send"} />
                  </Button>
                </div>
              </form>
            )}

            {commandError ? (
              <p className="inline-error" role="alert">
                {commandError}
              </p>
            ) : null}
          </section>
        ) : (
          <section className="no-session">
            <span className="terminal-prompt" aria-hidden="true">
              π
            </span>
            <h2>Start a session from anywhere.</h2>
            <p>
              Launch OMP here or connect a terminal session on this host. Updates stream into this workspace
              live.
            </p>
            <Button type="button" onClick={() => setLaunchOpen(true)}>
              <Icon name="plus" />
              Start session
            </Button>
          </section>
        )}
      </SidebarInset>

      <SubagentSessionViewer
        open={viewedSubagent !== null}
        mobile={isMobile}
        subagent={viewedSubagent}
        session={viewedSubagentSession}
        onOpenChange={(open) => {
          if (!open) setViewedSubagent(null);
        }}
      >
        {viewedSubagentSession?.messages.length ? (
          renderTranscriptMessageItems({
            messages: viewedSubagentSession.messages,
          })
        ) : (
          <MessageScrollerItem
            messageId={`subagent-empty:${viewedSubagentSession?.id ?? viewedSubagent?.id ?? "pending"}`}
          >
            <div className="empty-transcript">
              <span className="terminal-prompt" aria-hidden="true">
                π
              </span>
              <strong>
                {viewedSubagentSession ? "Waiting for subagent output" : "Connecting to subagent"}
              </strong>
              <p>
                {viewedSubagentSession
                  ? "Live output will appear here as the subagent works."
                  : "The session will appear as soon as the host publishes it."}
              </p>
            </div>
          </MessageScrollerItem>
        )}
        {viewedSubagentSession?.status === "running" ? (
          <MessageScrollerItem messageId={`working:${viewedSubagentSession.id}`}>
            <WorkingIndicator status={viewedSubagentSession.status} />
          </MessageScrollerItem>
        ) : null}
      </SubagentSessionViewer>

      <SessionFileChangesViewer
        open={fileChangesOpen}
        mobile={isMobile}
        result={visibleSessionFileChanges}
        loading={visibleSessionFileChangesLoading}
        error={visibleSessionFileChangesError}
        onOpenChange={handleFileChangesOpenChange}
      />
      <SessionBranchSelector
        open={branchSelectorOpen && Boolean(selectedSession?.branch)}
        mobile={isMobile}
        currentBranch={branchTopology?.currentBranch ?? selectedSession?.branch ?? ""}
        topology={branchTopology?.sessionId === selectedSession?.id ? branchTopology : null}
        query={branchQuery}
        loading={branchTopologyLoading}
        loadError={branchTopologyError}
        checkoutPending={branchCheckoutPending}
        checkoutError={branchCheckoutError}
        running={selectedSession?.status === "running"}
        onQueryChange={setBranchQuery}
        onSelectBranch={(branch) => void selectBranch(branch)}
        onOpenChange={handleBranchSelectorOpenChange}
      />
      <Drawer
        open={todoOpenSessionId === selectedSession?.id && currentTodo !== null}
        onOpenChange={(open) =>
          setTodoOpenSessionId(open && currentTodo ? (selectedSession?.id ?? null) : null)
        }
        {...getResponsiveDrawerProps(isMobile)}
      >
        <DrawerContent className="model-settings-sheet todo-tracker-sheet">
          <DrawerHeader className="model-settings-header todo-tracker-sheet-header">
            <div>
              <DrawerTitle>Current Todo</DrawerTitle>
              <DrawerDescription>
                Review the latest Todo progress and complete task list for this session.
              </DrawerDescription>
            </div>
            <DrawerClose
              render={
                <Button type="button" variant="ghost" size="icon" autoFocus aria-label="Close current Todo" />
              }
            >
              <Icon name="close" />
            </DrawerClose>
          </DrawerHeader>
          <div className="model-settings-body todo-tracker-sheet-body">
            {currentTodo ? (
              <>
                <TodoProgressSummary todo={currentTodo} />
                <TodoPhaseList todo={currentTodo} />
              </>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer
        open={configurationDrawer === "model"}
        onOpenChange={(open) => {
          if (configurationPending) return;
          setConfigurationDrawer(open ? "model" : null);
          if (!open) {
            setModelQuery("");
            setConfigurationError(null);
          }
        }}
        {...getResponsiveDrawerProps(isMobile)}
      >
        <DrawerContent className="model-settings-sheet">
          <DrawerHeader className="model-settings-header">
            <div>
              <DrawerTitle>Model</DrawerTitle>
              <DrawerDescription>Choose the model for this session.</DrawerDescription>
            </div>
            <DrawerClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close model settings"
                  disabled={configurationPending !== null}
                />
              }
            >
              <Icon name="close" />
            </DrawerClose>
          </DrawerHeader>
          <div className="model-settings-body" aria-busy={configurationPending !== null}>
            {selectedSession?.capabilities.includes("model") && availableModels.length > 0 ? (
              <>
                {availableModels.length > 8 ? (
                  <label className="model-search-field" htmlFor="model-settings-search">
                    <span className="sr-only">Search models</span>
                    <Icon name="search" />
                    <Input
                      id="model-settings-search"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder="Search models"
                      autoComplete="off"
                    />
                  </label>
                ) : null}
                <section className="model-settings-section" aria-labelledby="model-settings-model-heading">
                  <div className="model-settings-section-heading">
                    <h3 id="model-settings-model-heading">Model</h3>
                    <span>{availableModels.length} available</span>
                  </div>
                  <div className="model-option-list">
                    {filteredModels.map((model) => {
                      const value = `${model.provider}/${model.id}`;
                      const selected = value === selectedSession.model;
                      return (
                        <Button
                          className={cn("model-option", selected && "selected")}
                          type="button"
                          variant="ghost"
                          aria-pressed={selected}
                          disabled={configurationPending !== null}
                          onClick={() => void selectModel(value)}
                          key={value}
                        >
                          <span>
                            <strong>{model.name}</strong>
                            <small>{value}</small>
                          </span>
                          <span className="selection-indicator" aria-hidden="true" />
                        </Button>
                      );
                    })}
                    {filteredModels.length === 0 ? (
                      <p className="model-settings-empty">No models match “{modelQuery.trim()}”.</p>
                    ) : null}
                  </div>
                </section>
              </>
            ) : (
              <p className="model-settings-empty model-settings-unavailable">
                {selectedSession?.source !== "history"
                  ? "Restart this session with the latest extension to change its model."
                  : "Resume this session to load its available models."}
              </p>
            )}
            {configurationError?.drawer === "model" ? (
              <p className="inline-error model-settings-error" role="alert">
                {configurationError.message}
              </p>
            ) : null}
          </div>
          <DrawerFooter className="model-settings-footer">
            <DrawerClose
              render={
                <Button type="button" disabled={configurationPending !== null}>
                  Done
                </Button>
              }
            />
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Drawer
        open={configurationDrawer === "effort"}
        onOpenChange={(open) => {
          if (configurationPending) return;
          setConfigurationDrawer(open ? "effort" : null);
          if (!open) setConfigurationError(null);
        }}
        {...getResponsiveDrawerProps(isMobile)}
      >
        <DrawerContent className="model-settings-sheet">
          <DrawerHeader className="model-settings-header">
            <div>
              <DrawerTitle>Effort</DrawerTitle>
              <DrawerDescription>
                Choose the reasoning effort for {currentModelOption?.name ?? "this session"}.
              </DrawerDescription>
            </div>
            <DrawerClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close effort settings"
                  disabled={configurationPending !== null}
                />
              }
            >
              <Icon name="close" />
            </DrawerClose>
          </DrawerHeader>
          <div className="model-settings-body" aria-busy={configurationPending !== null}>
            {selectedSession?.capabilities.includes("effort") &&
            currentModelOption &&
            availableEfforts.length > 0 ? (
              <section className="model-settings-section" aria-labelledby="model-settings-effort-heading">
                <div className="model-settings-section-heading">
                  <h3 id="model-settings-effort-heading">Effort</h3>
                  <span>{currentModelOption.name}</span>
                </div>
                <div className="effort-options">
                  {availableEfforts.map((effort) => (
                    <Button
                      className={cn("effort-option", effort === selectedSession.effort && "selected")}
                      type="button"
                      variant="outline"
                      aria-pressed={effort === selectedSession.effort}
                      disabled={configurationPending !== null}
                      onClick={() => void selectEffort(effort)}
                      key={effort}
                    >
                      {formatEffortLabel(effort)}
                    </Button>
                  ))}
                </div>
              </section>
            ) : (
              <p className="model-settings-empty model-settings-unavailable">
                {selectedSession?.capabilities.includes("effort") &&
                currentModelOption &&
                availableEfforts.length === 0
                  ? "This model does not expose adjustable effort."
                  : selectedSession?.source !== "history"
                    ? "Restart this session with the latest extension to change its effort."
                    : "Resume this session to load its available effort choices."}
              </p>
            )}
            {configurationError?.drawer === "effort" ? (
              <p className="inline-error model-settings-error" role="alert">
                {configurationError.message}
              </p>
            ) : null}
          </div>
          <DrawerFooter className="model-settings-footer">
            <DrawerClose
              render={
                <Button type="button" disabled={configurationPending !== null}>
                  Done
                </Button>
              }
            />
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Dialog
        open={launchOpen}
        onOpenChange={(open) => {
          setLaunchOpen(open);
          if (!open) {
            setSavedDirectoryError(null);
            setLaunchError(null);
          }
        }}
        title="Start an OMP session"
        description="Choose a working directory. Add a saved session ID or JSONL path to resume it."
      >
        <form className="launch-form" onSubmit={submitLaunch}>
          <div className="launch-field">
            <label htmlFor="launch-cwd">Working directory</label>
            <div className="launch-cwd-control">
              <Input
                id="launch-cwd"
                name="cwd"
                required
                placeholder="/Users/you/project"
                autoComplete="off"
                autoFocus
                value={launchCwd}
                onChange={(event) => setLaunchCwd(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!launchCwd.trim() || savedDirectoryPending !== null}
                onClick={() => void saveWorkingDirectory()}
              >
                {savedDirectoryPending?.action === "save" ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          {savedWorkingDirectories.length > 0 ? (
            <section className="saved-directory-list" aria-label="Saved working directories">
              {savedWorkingDirectories.map((cwd) => (
                <div className="saved-directory-item" key={cwd}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="saved-directory-select"
                    disabled={savedDirectoryPending !== null}
                    onClick={() => setLaunchCwd(cwd)}
                  >
                    {cwd}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove saved working directory ${cwd}`}
                    disabled={savedDirectoryPending !== null}
                    onClick={() => void removeWorkingDirectory(cwd)}
                  >
                    <Icon name="trash" />
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          <label htmlFor="launch-resume">
            <span>
              Resume ID or path <small>Optional</small>
            </span>
            <Input
              id="launch-resume"
              name="resume"
              placeholder="Session ID or .jsonl path"
              autoComplete="off"
            />
          </label>
          {savedDirectoryError ? (
            <p className="inline-error saved-directory-error" role="alert">
              {savedDirectoryError}
            </p>
          ) : null}
          {launchError ? (
            <p className="inline-error" role="alert">
              {launchError}
            </p>
          ) : null}
          <footer className="dialog-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={launchState === "sending"}
              onClick={() => setLaunchOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={launchState === "sending"}>
              {launchState === "sending" ? "Starting…" : "Start session"}
            </Button>
          </footer>
        </form>
      </Dialog>

      <Dialog
        open={abortOpen}
        onOpenChange={setAbortOpen}
        title="Abort this run?"
        description="OMP will stop the active run. The session and transcript stay available."
      >
        <footer className="dialog-actions">
          <Button type="button" variant="ghost" onClick={() => setAbortOpen(false)}>
            Keep running
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={commandState === "sending"}
            onClick={() => void abortSelectedSession()}
          >
            Abort run
          </Button>
        </footer>
      </Dialog>

      <Dialog
        open={killOpen}
        onOpenChange={setKillOpen}
        dismissible={commandState !== "sending"}
        title="Kill this session?"
        description="This ends the OMP process and its active run. The transcript stays available as a saved session."
      >
        {commandError ? (
          <p className="inline-error" role="alert">
            {commandError}
          </p>
        ) : null}
        <footer className="dialog-actions kill-dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={commandState === "sending"}
            onClick={() => setKillOpen(false)}
          >
            Keep session
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={commandState === "sending"}
            aria-busy={commandState === "sending"}
            onClick={() => void killSelectedSession()}
          >
            {commandState === "sending" ? "Killing…" : "Kill session"}
          </Button>
        </footer>
      </Dialog>
    </div>
  );
}

function Icon({
  name,
}: {
  name: "bell" | "close" | "down" | "plus" | "power" | "search" | "send" | "stop" | "trash" | "up";
}) {
  const paths = {
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    down: <path d="m6 9 6 6 6-6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    power: (
      <>
        <path d="M12 3v9" />
        <path d="M7.1 5.7a8 8 0 1 0 9.8 0" />
      </>
    ),
    search: <path d="m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />,
    send: <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="m9 7 1-3h4l1 3" />
        <path d="m6 7 1 14h10l1-14M10 11v6M14 11v6" />
      </>
    ),
    up: <path d="m6 15 6-6 6 6" />,
  } as const;
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function compactPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatEffortLabel(effort: Effort | null | undefined): string {
  if (!effort) return "Default effort";
  if (effort === "off") return "No reasoning";
  if (effort === "xhigh") return "Extra high";
  return `${effort[0]?.toUpperCase()}${effort.slice(1)}`;
}
