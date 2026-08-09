import { type Session } from "@omp-remote/protocol";
import { Badge } from "../ui/badge.js";
import { MessageScrollerItem, useMessageScroller } from "../ui/message-scroller.js";
import { cn } from "../ui/utils.js";
import { memo, useEffect, useMemo } from "react";
import { classifyDiffLine } from "./blocks.js";
import { TranscriptDiff, TranscriptText, formatSystemTextPreview } from "./code-block.js";
import {
  getDisclosurePlainText,
  parseDisclosureImages,
  renderDisclosureTranscriptContent,
} from "./disclosure-content.js";
import { tokenizeBashTitle } from "./bash-title.js";
import { ToolTranscriptText } from "./tool-transcript.js";

const BASH_TITLE_PREFIX = "Bash: ";
type TranscriptEntryMessage = Session["messages"][number];

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

function renderToolTitle(entry: TranscriptEntryMessage, fallbackLabel: string) {
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

export function TranscriptEntryHeader({
  entry,
  authorLabel,
  collapsible = false,
}: {
  entry: TranscriptEntryMessage;
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

export function SystemTranscriptText({ entry }: { entry: TranscriptEntryMessage }) {
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

export function TranscriptEntryContent({ entry }: { entry: TranscriptEntryMessage }) {
  return entry.presentation === "diff" ? (
    <div className="transcript-message">
      <TranscriptDiff lines={entry.text.split("\n").map(classifyDiffLine)} />
    </div>
  ) : (
    <TranscriptText text={entry.text} />
  );
}

export function ToolOutputDivider() {
  return (
    <div className="tool-output-divider">
      <span>Output</span>
    </div>
  );
}

const MemoizedToolTranscriptText = memo(ToolTranscriptText);

export function TranscriptEntry({ entry }: { entry: TranscriptEntryMessage }) {
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

export function renderTranscriptMessageItems({ messages }: { messages: readonly TranscriptEntryMessage[] }) {
  return messages.map((entry) =>
    !entry.text && entry.role !== "tool" ? null : (
      <MessageScrollerItem key={entry.id} messageId={entry.id} scrollAnchor={entry.role === "user"}>
        <TranscriptEntry entry={entry} />
      </MessageScrollerItem>
    ),
  );
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
