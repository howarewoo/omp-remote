import type { Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Separator } from "./ui/separator.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar.js";
import { Textarea } from "./ui/textarea.js";
import { cn } from "./ui/utils.js";

type ComposerMode = "prompt" | "steer" | "follow_up";
type SessionSection = {
  id: "connected" | "disconnected";
  label: "Connected" | "Disconnected";
  sessions: Session[];
};

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

export function groupSessionsByConnection(sessions: Session[]): SessionSection[] {
  const connected: Session[] = [];
  const disconnected: Session[] = [];

  for (const session of sessions) {
    (session.connected ? connected : disconnected).push(session);
  }

  const sections: SessionSection[] = [
    { id: "connected", label: "Connected", sessions: connected },
    { id: "disconnected", label: "Disconnected", sessions: disconnected },
  ];
  return sections.filter((section) => section.sessions.length > 0);
}

export function formatSubagentActivityLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"} running`;
}

export interface DashboardProps {
  sessions: Session[];
  totalSessions: number;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  onLaunch(cwd: string, resume: string | null): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onAbort(sessionId: string): Promise<void>;
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

export function ToolTranscriptText({ entry }: { entry: Session["messages"][number] }) {
  return (
    <details className="tool-message-disclosure">
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
function DashboardContent({
  sessions,
  totalSessions,
  historyLoading,
  hasMoreHistory,
  connection,
  error,
  onLaunch,
  onCommand,
  onAbort,
  onSearchHistory,
  onLoadMoreHistory,
  onLoadTranscript,
}: DashboardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode>("prompt");
  const [message, setMessage] = useState("");
  const [commandState, setCommandState] = useState<"idle" | "sending">("idle");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [abortOpen, setAbortOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [activeHistoryQuery, setActiveHistoryQuery] = useState("");
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);
  const loadedTranscriptIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  const { closeMobile } = useSidebar();

  const sessionSections = useMemo(() => groupSessionsByConnection(sessions), [sessions]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessionSections[0]?.sessions[0] ?? null,
    [selectedId, sessionSections, sessions],
  );

  useEffect(() => {
    if (selectedSession && selectedSession.id !== selectedId) setSelectedId(selectedSession.id);
  }, [selectedId, selectedSession]);

  useEffect(() => {
    followTranscriptRef.current = true;
  }, [selectedSession?.id]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [selectedSession?.messages.length, selectedSession?.messages.at(-1)?.text]);

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

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSession || !message.trim() || commandState === "sending") return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onCommand(selectedSession.id, composerMode, message.trim());
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
    const form = new FormData(event.currentTarget);
    const cwd = String(form.get("cwd") ?? "").trim();
    const resume = String(form.get("resume") ?? "").trim();
    if (!cwd) return;
    setLaunchError(null);
    try {
      await onLaunch(cwd, resume || null);
      setLaunchOpen(false);
      event.currentTarget.reset();
    } catch (launchFailure) {
      setLaunchError(
        launchFailure instanceof Error ? launchFailure.message : "OMP could not start the session",
      );
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

  return (
    <div className="app-shell">
      <Sidebar>
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
          <div className="session-list-heading">
            <span>Sessions</span>
            <span>{totalSessions.toLocaleString()}</span>
          </div>
          <nav className="session-list" aria-label="Registered OMP sessions">
            {sessions.length === 0 ? (
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
                    <span>
                      {section.sessions.length.toLocaleString()}
                      <span className="sr-only">
                        {" "}
                        {section.sessions.length === 1 ? "session" : "sessions"}
                      </span>
                    </span>
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
                          setSelectedId(session.id);
                          closeMobile();
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
      </Sidebar>

      <SidebarInset>
        <header className="session-header">
          <div className="session-header-primary">
            <SidebarTrigger />
            {selectedSession ? (
              <>
                <div>
                  <h1>{selectedSession.name ?? "Untitled session"}</h1>
                  <p>{selectedSession.cwd}</p>
                </div>
                <Badge
                  className={cn("status-badge", `status-${SESSION_STATUS_TONE[selectedSession.status]}`)}
                >
                  <span aria-hidden="true" />
                  {SESSION_STATUS_LABEL[selectedSession.status]}
                </Badge>
              </>
            ) : (
              <h1>OMP Remote</h1>
            )}
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
            <div className="session-overview">
              <div className="session-title-block">
                <span className="session-source">
                  {selectedSession.source === "rpc"
                    ? "Remote session"
                    : selectedSession.source === "extension"
                      ? "Terminal session"
                      : "Saved session"}
                </span>
                <h2>
                  {selectedSession.name ??
                    selectedSession.cwd.split("/").filter(Boolean).at(-1) ??
                    "Untitled session"}
                </h2>
              </div>
              <dl className="session-metadata">
                <div>
                  <dt>Model</dt>
                  <dd>{selectedSession.model ?? "Default"}</dd>
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
            </div>

            {selectedSession.activeSubagents.length > 0 ? (
              <section className="subagent-activity" aria-label="Active subagents" aria-live="polite">
                <strong className="subagent-activity-heading">
                  {formatSubagentActivityLabel(selectedSession.activeSubagents.length)}
                </strong>
                <ul className="subagent-list">
                  {selectedSession.activeSubagents.slice(0, 5).map((subagent) => (
                    <li key={subagent.id}>
                      <span>{subagent.name}</span>
                      <time dateTime={subagent.lastActivity}>{formatTime(subagent.lastActivity)}</time>
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

            <Separator />

            <div
              ref={transcriptRef}
              className="transcript"
              role="log"
              aria-live="polite"
              aria-label="Session transcript"
              onScroll={(event) => {
                const target = event.currentTarget;
                followTranscriptRef.current =
                  target.scrollHeight - target.scrollTop - target.clientHeight < 80;
              }}
            >
              {transcriptLoadingId === selectedSession.id ? (
                <div className="empty-transcript" role="status">
                  <span className="status-orbit" aria-hidden="true" />
                  <strong>Reading session transcript</strong>
                  <p>Large transcripts stay on the host and load only when selected.</p>
                </div>
              ) : selectedSession.messages.length === 0 ? (
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
                <div className="composer-toolbar">
                  <fieldset className="mode-switch" aria-label="Command delivery mode">
                    {(["prompt", "steer", "follow_up"] as const).map((mode) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        key={mode}
                        aria-pressed={composerMode === mode}
                        onClick={() => setComposerMode(mode)}
                        disabled={!selectedSession.capabilities.includes(mode)}
                      >
                        {mode === "follow_up" ? "Follow up" : mode[0]?.toUpperCase() + mode.slice(1)}
                      </Button>
                    ))}
                  </fieldset>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="abort-button"
                    disabled={
                      !selectedSession.capabilities.includes("abort") || selectedSession.status !== "running"
                    }
                    onClick={() => setAbortOpen(true)}
                  >
                    <Icon name="stop" />
                    Abort
                  </Button>
                </div>
                <div className="composer-field">
                  <label className="sr-only" htmlFor="composer-message">
                    {composerMode === "prompt"
                      ? "New instruction"
                      : composerMode === "steer"
                        ? "Steer current run"
                        : "Queue after run"}
                  </label>
                  <Textarea
                    id="composer-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder={
                      composerMode === "steer"
                        ? "Redirect the current run…"
                        : composerMode === "follow_up"
                          ? "Queue the next instruction…"
                          : "Ask OMP to build, investigate, or change something…"
                    }
                    rows={3}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                        event.currentTarget.form?.requestSubmit();
                    }}
                  />
                  <Button
                    className="send-button"
                    type="submit"
                    size="icon"
                    disabled={!message.trim() || commandState === "sending"}
                    aria-label={commandState === "sending" ? "Sending instruction" : "Send instruction"}
                  >
                    <Icon name="send" />
                  </Button>
                </div>
                <div className="composer-footer">
                  <span>⌘ ↵ to send</span>
                  {selectedSession.status === "running" ? (
                    <span className="live-copy">Live output connected</span>
                  ) : null}
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

      <Dialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        title="Start an OMP session"
        description="Choose a working directory. Add a saved session ID or JSONL path to resume it."
      >
        <form className="launch-form" onSubmit={submitLaunch}>
          <label htmlFor="launch-cwd">
            <span>Working directory</span>
            <Input
              id="launch-cwd"
              name="cwd"
              required
              placeholder="/Users/you/project"
              autoComplete="off"
              autoFocus
            />
          </label>
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
          {launchError ? (
            <p className="inline-error" role="alert">
              {launchError}
            </p>
          ) : null}
          <footer className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => setLaunchOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Start session</Button>
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
    </div>
  );
}

function Icon({ name }: { name: "plus" | "search" | "send" | "stop" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: <path d="m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />,
    send: <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
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
