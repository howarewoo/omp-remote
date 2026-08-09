import { type Session, type TranscriptImage } from "@omp-remote/protocol";
import { memo, useEffect, useState } from "react";
import { parseTodoResult } from "../todo-parser.js";
import {
  DisclosureImage,
  getDisclosurePlainText,
  parseDisclosureImages,
  renderDisclosureTranscriptContent,
  renderDisclosureTranscriptText,
} from "./disclosure-content.js";
import { MemoizedTodoToolTranscript } from "./todo-tool-transcript.js";
import { TranscriptEntryContent, TranscriptEntryHeader, ToolOutputDivider } from "./transcript-entry.js";

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
  className,
  readTarget,
}: {
  entry: TranscriptEntryMessage;
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

export function ToolTranscriptText({ entry }: { entry: TranscriptEntryMessage }) {
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

export const MemoizedToolTranscriptText = memo(ToolTranscriptText);
