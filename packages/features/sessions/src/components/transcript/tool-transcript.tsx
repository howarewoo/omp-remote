import { type Session, type TranscriptImage } from "@omp-remote/protocol";
import { memo, useEffect, useState } from "react";
import { Badge } from "../ui/badge.js";
import { parseTodoResult } from "../todo-parser.js";
import {
  DisclosureImage,
  getDisclosurePlainText,
  parseDisclosureImages,
  renderDisclosureTranscriptContent,
  renderDisclosureTranscriptText,
} from "./disclosure-content.js";
import { MemoizedTodoToolTranscript } from "./todo-tool-transcript.js";
import { TranscriptDisclosure, type DisclosureCategory } from "./transcript-disclosure.js";
import {
  formatTime,
  renderToolTitle,
  ToolOutputDivider,
  TranscriptEntryContent,
} from "./transcript-entry.js";
const TOOL_TEXT_PREVIEW_LINES = 10;
const TOOL_TEXT_PREVIEW_CHARS = 1_200;
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
  if (preview.length > TOOL_TEXT_PREVIEW_CHARS) {
    return `…${preview.slice(-(TOOL_TEXT_PREVIEW_CHARS - 1))}`;
  }
  return formatToolTextFull(preview);
}

function countDisplayedLines(text: string): number {
  if (text.length === 0) return 1;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return Math.max(1, lines.length);
}

type TranscriptEntryMessage = Session["messages"][number];

function splitReadTarget(target: string): { path: string; selector: string } {
  const lastSlash = target.lastIndexOf("/");
  const selectorIndex = target.indexOf(":", lastSlash + 1);
  return selectorIndex === -1
    ? { path: target, selector: "" }
    : { path: target.slice(0, selectorIndex), selector: target.slice(selectorIndex) };
}

export function getReadToolTarget(entry: TranscriptEntryMessage): string | undefined {
  return entry.readTarget ?? entry.text.match(/^\[([^\]\r\n]+)#[\dA-Fa-f]{4}\](?:\r?\n|$)/)?.[1];
}

function getReadToolFilename(target?: string): string | null {
  if (!target) return null;

  const { path } = splitReadTarget(target);
  return path.slice(path.lastIndexOf("/") + 1) || null;
}

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
  readTarget,
}: {
  entry: TranscriptEntryMessage;
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
  const expandable =
    entry.streaming === true || hasImages || hiddenLineCount > 0 || Boolean(entry.readResolvedPath);

  return (
    <TranscriptDisclosure
      badge={entry.streaming ? <Badge className="streaming-badge">Streaming</Badge> : null}
      category="read"
      className="tool-message-disclosure read-result-disclosure tool-output-disclosure"
      expandable={expandable}
      defaultOpen={false}
      keepMounted={hasImages}
      lifecycle={entry.streaming ? "running" : undefined}
      preview={
        <>
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
        </>
      }
      time={formatTime(entry.timestamp)}
      timestamp={entry.timestamp}
      title={renderToolTitle(entry, authorLabel)}
    >
      {hasImages
        ? renderReadImageDisclosureContent({
            imageSources,
            readTarget: readImageLabel,
            text: entry.text,
            variant: "expanded",
          })
        : renderDisclosureTranscriptText(entry.text)}
      {!hasImages && entry.readResolvedPath ? (
        <div className="read-result-output">
          <div className="read-result-resolved-path">
            <span>Resolved path: {entry.readResolvedPath}</span>
          </div>
        </div>
      ) : null}
    </TranscriptDisclosure>
  );
}

export function ToolTranscriptText({ entry }: { entry: TranscriptEntryMessage }) {
  const lifecycle = entry.lifecycle?.state ?? (entry.streaming ? "running" : undefined);
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
  const className = "tool-message-disclosure tool-output-disclosure";

  if (isInspectableRead) {
    return <ReadResultTranscript entry={entry} readTarget={readTarget} />;
  }

  if (isRead) {
    return (
      <TranscriptDisclosure
        category="read"
        className={className}
        expandable={false}
        time={formatTime(entry.timestamp)}
        timestamp={entry.timestamp}
        title={renderToolTitle(entry, authorLabel)}
      >
        {null}
      </TranscriptDisclosure>
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
  const hasDisclosureImages = disclosureSegments?.some((segment) => segment.kind === "image") ?? false;
  const expandable =
    entry.streaming === true ||
    hasDisclosureImages ||
    entry.text.length > TOOL_TEXT_PREVIEW_CHARS ||
    countDisplayedLines(entry.text) > TOOL_TEXT_PREVIEW_LINES;

  return (
    <TranscriptDisclosure
      badge={entry.streaming ? <Badge className="streaming-badge">Streaming</Badge> : null}
      category={(entry.toolName as DisclosureCategory) ?? "tool"}
      className={className}
      expandable={expandable}
      defaultOpen={entry.toolName === "edit" || entry.streaming === true}
      lifecycle={lifecycle}
      preview={
        <>
          <ToolOutputDivider />
          {isWrite ? (
            renderDisclosureTranscriptText(
              expandable ? formatToolTextPreview(entry.text) : formatToolTextFull(entry.text),
              false,
            )
          ) : entry.presentation === "diff" ? (
            expandable ? (
              <pre className="tool-message-preview">{formatToolTextPreview(entry.text)}</pre>
            ) : (
              <TranscriptEntryContent entry={entry} />
            )
          ) : (
            renderDisclosureTranscriptContent({
              preview: disclosurePreview ?? "",
              segments: disclosureSegments ?? [],
              variant: "thumbnail",
            })
          )}
        </>
      }
      time={formatTime(entry.timestamp)}
      timestamp={entry.timestamp}
      title={renderToolTitle(entry, authorLabel)}
    >
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
    </TranscriptDisclosure>
  );
}

export const MemoizedToolTranscriptText = memo(ToolTranscriptText);
