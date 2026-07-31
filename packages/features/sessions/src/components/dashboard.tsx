import {
  type ActiveSubagent,
  type AskRequest,
  type AskResponse,
  type Effort,
  filterMainSessions,
  type Session,
} from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type FormEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
} from "./ui/drawer.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";
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

export function isNearTranscriptBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < 80;
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

const INLINE_MARKUP_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
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
  "with",
  "yield",
]);

export function parseInlineTranscript(text: string): InlineTranscriptToken[] {
  const tokens: InlineTranscriptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_MARKUP_PATTERN)) {
    const start = match.index;
    if (start > cursor) tokens.push({ kind: "text", text: text.slice(cursor, start) });

    const raw = match[0];
    if (raw.startsWith("`")) {
      tokens.push({ kind: "code", text: raw.slice(1, -1) });
    } else if (raw.startsWith("**")) {
      tokens.push({ kind: "strong", text: raw.slice(2, -2) });
    } else {
      const labelEnd = raw.indexOf("](");
      tokens.push({
        kind: "link",
        text: raw.slice(1, labelEnd),
        href: raw.slice(labelEnd + 2, -1),
      });
    }
    cursor = start + raw.length;
  }

  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
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
  onLaunch(cwd: string, resume: string | null): Promise<void>;
  onSaveWorkingDirectory(cwd: string): Promise<void>;
  onRemoveWorkingDirectory(cwd: string): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onAbort(sessionId: string): Promise<void>;
  onKill(sessionId: string): Promise<void>;
  onSetModel(sessionId: string, model: string): Promise<void>;
  onSetEffort(sessionId: string, effort: Effort): Promise<void>;
  onRespondToAsk(sessionId: string, askRequestId: string, response: AskResponse): Promise<void>;
  onSearchHistory(query: string): Promise<void>;
  onLoadMoreHistory(): Promise<void>;
  onLoadTranscript(sessionId: string): Promise<void>;
}

export function Dashboard(props: DashboardProps) {
  return (
    <SidebarProvider>
      <DashboardContent {...props} />
    </SidebarProvider>
  );
}

const InlineTranscript = memo(function InlineTranscript({ text }: { text: string }) {
  const tokens = useMemo(() => parseInlineTranscript(text), [text]);

  return tokens.map((token, index) => {
    if (token.kind === "link") {
      return (
        <a href={token.href} key={`${index}:link`} rel="noreferrer" target="_blank">
          {token.text}
        </a>
      );
    }
    if (token.kind === "code") {
      return <code key={`${index}:code`}>{token.text}</code>;
    }
    if (token.kind === "strong") {
      return <strong key={`${index}:strong`}>{token.text}</strong>;
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
    <details className="code-block">
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

export function formatToolTextPreview(text: string): string {
  let end = text.length;
  if (text.charCodeAt(end - 1) === 10) {
    end -= 1;
    if (text.charCodeAt(end - 1) === 13) end -= 1;
  }
  if (end === 0) return "No tool output";

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
  return /\S/.test(preview) ? preview : "No tool output";
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
    const phaseMatch = /^  ([^:\n]+):$/.exec(line);
    const phaseName = phaseMatch?.[1];
    if (phaseName !== undefined) {
      if (phaseName.trim() !== phaseName) return null;
      currentPhase = { name: phaseName, state: "pending", tasks: [] };
      phases.push(currentPhase);
      continue;
    }

    const taskMatch =
      /^    - \[([ xX])\] (.+?)(?: \((pending|in progress|completed|blocked|dropped)(?:: ([^)]+))?\))?$/.exec(
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
  const blocks = useMemo(() => parseTranscriptBlocks(text || "…"), [text]);

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

function TranscriptEntryHeader({
  entry,
  collapsible = false,
}: {
  entry: Session["messages"][number];
  collapsible?: boolean;
}) {
  return (
    <header>
      <span className="message-author">
        <i aria-hidden="true">{entry.role === "assistant" ? "π" : entry.role === "user" ? "›" : "·"}</i>
        {entry.role === "assistant" ? "OMP" : entry.role === "user" ? "You" : (entry.toolName ?? entry.role)}
        {collapsible ? <span className="message-disclosure-chevron" aria-hidden="true" /> : null}
      </span>
      <time dateTime={entry.timestamp}>{formatTime(entry.timestamp)}</time>
      {entry.streaming ? <Badge className="streaming-badge">Streaming</Badge> : null}
    </header>
  );
}

export function SystemTranscriptText({ entry }: { entry: Session["messages"][number] }) {
  return (
    <details className="system-message-disclosure">
      <summary>
        <TranscriptEntryHeader entry={entry} collapsible />
        <span className="system-message-preview">{formatSystemTextPreview(entry.text)}</span>
      </summary>
      <TranscriptText text={entry.text} />
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

export function TodoToolTranscript({
  entry,
  todo,
}: {
  entry: Session["messages"][number];
  todo: TodoResult;
}) {
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
  const terminalLabel = hasDroppedTasks ? "No tasks remain" : "All tasks complete";
  const terminalState: TodoTaskState = hasDroppedTasks ? "dropped" : "completed";
  const progressVerb = hasDroppedTasks ? "resolved" : "complete";

  return (
    <details className="tool-message-disclosure todo-tool-disclosure">
      <summary>
        <TranscriptEntryHeader entry={entry} collapsible />
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
            <span
              aria-hidden="true"
              className="todo-state-marker"
              data-state={
                activeTask?.state ?? (todo.overall.done === todo.overall.total ? terminalState : "pending")
              }
            />
            <span>
              <span className="sr-only">{activeTask ? `${TODO_STATE_LABEL[activeTask.state]}: ` : ""}</span>
              {activeTask?.label ??
                (todo.overall.done === todo.overall.total ? terminalLabel : `${open} tasks open`)}
            </span>
          </div>
        </div>
      </summary>
      <div className="todo-phase-list">
        {todo.phases.map((phase, phaseIndex) => (
          <section className="todo-phase" key={`${phaseIndex}:${phase.name}`}>
            <header>
              <h3>{phase.name}</h3>
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
                    {task.label}
                    {task.reason ? (
                      <span className="todo-task-reason">
                        <span className="sr-only">Blocked reason: </span>
                        {task.reason}
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
    </details>
  );
}

const MemoizedTodoToolTranscript = memo(TodoToolTranscript);

export function ToolTranscriptText({ entry }: { entry: Session["messages"][number] }) {
  const todo = entry.toolName === "todo" ? parseTodoResult(entry.text) : null;
  if (todo) return <MemoizedTodoToolTranscript entry={entry} todo={todo} />;

  return (
    <details className="tool-message-disclosure" open={entry.toolName === "edit"}>
      <summary>
        <TranscriptEntryHeader entry={entry} collapsible />
        <pre className="tool-message-preview">{formatToolTextPreview(entry.text)}</pre>
      </summary>
      <TranscriptEntryContent entry={entry} />
    </details>
  );
}

const MemoizedToolTranscriptText = memo(ToolTranscriptText);

export function TranscriptEntry({ entry }: { entry: Session["messages"][number] }) {
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
}

export function AskToolCall({ request, connection, onRespond }: AskToolCallProps) {
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
        {request.title}
      </strong>
      {request.kind === "select" ? (
        <>
          <div className="ask-options">
            {request.options.map((option, index) => (
              <Button
                type="button"
                variant="outline"
                className="ask-option"
                disabled={sending || connection !== "connected"}
                onClick={() => void respond({ value: option })}
                key={`${option}-${index}`}
              >
                {option}
              </Button>
            ))}
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
  onSearchHistory,
  onLoadMoreHistory,
  onLoadTranscript,
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
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const loadedTranscriptIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  const configurationRequestRef = useRef<{ sessionId: string } | null>(null);
  const configurationSessionIdRef = useRef<string | null>(null);
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
  const activeAskRequest = getActiveAskRequest(askRequests, selectedSession?.id ?? null);
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
    followTranscriptRef.current = true;
    setShowScrollToBottom(false);
  }, [selectedSession?.id]);

  useEffect(() => {
    setViewedSubagent(null);
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    configurationSessionIdRef.current = selectedSession?.id ?? null;
    configurationRequestRef.current = null;
    setConfigurationDrawer(null);
    setModelQuery("");
    setConfigurationPending(null);
    setConfigurationError(null);
  }, [selectedSession?.id]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !followTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
    setShowScrollToBottom(false);
  }, [
    activeAskRequest?.requestId,
    activeAskRequest?.sessionId,
    selectedSession?.id,
    selectedSession?.messages.length,
    selectedSession?.messages.at(-1)?.text,
  ]);

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
      await onLaunch(cwd, resume || null);
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
      await onLaunch(selectedSession.cwd, selectedSession.sessionPath);
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
                    return (
                      <button
                        className={cn("session-item", selected && "session-item-selected")}
                        type="button"
                        key={session.id}
                        aria-current={selected ? "page" : undefined}
                        aria-label={`${displayName}, ${SESSION_STATUS_LABEL[session.status]}`}
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
                            `session-state-${SESSION_STATUS_TONE[session.status]}`,
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
            {selectedSession ? (
              <>
                <div>
                  <h1>{selectedSession.name ?? "Untitled session"}</h1>
                  <div className="session-header-details">
                    <p>{selectedSession.cwd}</p>
                    {selectedSession.branch ? (
                      <span className="session-branch">
                        <span aria-hidden="true">git:</span>
                        <span className="sr-only">Git branch </span>
                        {selectedSession.branch}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Badge
                  className={cn("status-badge", `status-${SESSION_STATUS_TONE[selectedSession.status]}`)}
                >
                  <span aria-hidden="true" />
                  {SESSION_STATUS_LABEL[selectedSession.status]}
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
            <Separator />

            <div className="transcript-region">
              <div
                ref={transcriptRef}
                className="transcript"
                onScroll={(event) => {
                  const target = event.currentTarget;
                  const isNearBottom = isNearTranscriptBottom(
                    target.scrollHeight,
                    target.scrollTop,
                    target.clientHeight,
                  );
                  followTranscriptRef.current = isNearBottom;
                  setShowScrollToBottom(!isNearBottom);
                }}
              >
                <div
                  className="transcript-messages"
                  role="log"
                  aria-live="polite"
                  aria-label="Session transcript"
                >
                  {transcriptLoadingId === selectedSession.id ? (
                    <div className="empty-transcript" role="status">
                      <span className="status-orbit" aria-hidden="true" />
                      <strong>Reading session transcript</strong>
                      <p>Large transcripts stay on the host and load only when selected.</p>
                    </div>
                  ) : selectedSession.messages.length === 0 && !activeAskRequest ? (
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
                  ) : (
                    selectedSession.messages.map((entry) => <TranscriptEntry entry={entry} key={entry.id} />)
                  )}
                </div>
                {activeAskRequest ? (
                  <AskToolCall
                    key={`${activeAskRequest.sessionId}:${activeAskRequest.requestId}`}
                    request={activeAskRequest}
                    connection={connection}
                    onRespond={(response) =>
                      onRespondToAsk(activeAskRequest.sessionId, activeAskRequest.requestId, response)
                    }
                  />
                ) : null}
              </div>
              {showScrollToBottom ? (
                <Button
                  className="scroll-to-bottom-button"
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label="Scroll to latest output"
                  title="Scroll to latest output"
                  onClick={() => {
                    const transcript = transcriptRef.current;
                    if (!transcript) return;
                    followTranscriptRef.current = true;
                    transcript.scrollTop = transcript.scrollHeight;
                    setShowScrollToBottom(false);
                  }}
                >
                  <Icon name="down" />
                </Button>
              ) : null}
            </div>
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
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={selectedSession.lastActivity}>
                    {formatTime(selectedSession.lastActivity)}
                  </time>
                </dd>
              </div>
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
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.currentTarget.form?.requestSubmit();
                        return;
                      }
                      if (visibleSkillSuggestions.length === 0) return;
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const direction = event.key === "ArrowDown" ? 1 : -1;
                        setActiveSkillIndex(
                          (current) =>
                            (current + direction + visibleSkillSuggestions.length) %
                            visibleSkillSuggestions.length,
                        );
                      } else if (event.key === "Enter" || event.key === "Tab") {
                        event.preventDefault();
                        if (activeSkillSuggestion) selectSkillSuggestion(activeSkillSuggestion.name);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setAutocompleteDismissedFor(message);
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
                <div className="composer-footer">
                  <span>⌘ ↵ to send</span>
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
          viewedSubagentSession.messages.map((entry) => <TranscriptEntry entry={entry} key={entry.id} />)
        ) : (
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
        )}
      </SubagentSessionViewer>

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
        showSwipeHandle
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
        showSwipeHandle
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
