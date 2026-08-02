import type {
  SessionChangedFile,
  SessionFileChangesResponse,
  SessionFileOperation,
} from "@omp-remote/protocol";
import { type Ref, useEffect, useRef, useState } from "react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "./ui/drawer.js";

const INITIAL_VISIBLE_FILE_COUNT = 50;
const FILE_REVEAL_COUNT = 50;
const INITIAL_VISIBLE_OPERATION_COUNT = 50;
const OPERATION_REVEAL_COUNT = 50;
const MAX_RENDERED_PATCH_LINES = 500;

interface SessionFileChangesViewerProps {
  open: boolean;
  mobile: boolean;
  result: SessionFileChangesResponse | null;
  loading: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
}

export function formatSessionFileChangesSummary(counts: {
  fileCount: number;
  operationCount: number;
}): string {
  const files = `${counts.fileCount} ${counts.fileCount === 1 ? "file" : "files"}`;
  const operations = `${counts.operationCount} ${counts.operationCount === 1 ? "operation" : "operations"}`;
  return `${files} · ${operations}`;
}

export function formatSessionFileChangesMetadata(
  result: SessionFileChangesResponse | null,
  error: string | null,
  loading = false,
): string {
  if (loading) return "Reading changes…";
  if (error || result?.state === "unavailable") return "Changes unavailable";
  if (!result) return "View changes";
  const summary = formatSessionFileChangesSummary({
    fileCount: aggregateSessionChangedFiles(result).length,
    operationCount: result.operationCount,
  });
  return result.state === "partial" ? `Partial · ${summary}` : summary;
}

export function sessionFileChangesViewerLayout(mobile: boolean) {
  return mobile
    ? ({ showSwipeHandle: true, swipeDirection: "down" } as const)
    : ({ showSwipeHandle: false, swipeDirection: "right" } as const);
}

export function aggregateSessionChangedFiles(result: SessionFileChangesResponse): SessionChangedFile[] {
  const operationsByPath = new Map<string, SessionFileOperation[]>();
  for (const source of result.sources) {
    for (const file of source.files) {
      const operations = operationsByPath.get(file.path);
      if (operations) operations.push(...file.operations);
      else operationsByPath.set(file.path, [...file.operations]);
    }
  }
  return Array.from(operationsByPath, ([path, operations]) => ({
    path,
    operations: operations.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
  }));
}

export function SessionFileChangesViewer({
  open,
  mobile,
  result,
  loading,
  error,
  onOpenChange,
}: SessionFileChangesViewerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...sessionFileChangesViewerLayout(mobile)}>
      <DrawerContent className="session-changes-panel">
        <DrawerHeader className="subagent-session-header session-changes-header">
          <div>
            <DrawerTitle>Session file changes.</DrawerTitle>
            <DrawerDescription>Recorded edit and write operations for this session tree</DrawerDescription>
          </div>
          <DrawerClose
            className="session-changes-close"
            render={
              <Button type="button" variant="ghost" size="icon" aria-label="Close session file changes" />
            }
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </DrawerClose>
        </DrawerHeader>
        <div className="session-changes-body" aria-busy={loading}>
          <SessionFileChangesContentWithReveal
            key={result?.sessionId ?? "empty"}
            result={result}
            loading={loading}
            error={error}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function SessionFileChangesContent({
  result,
  loading,
  error,
  visibleFileCount = INITIAL_VISIBLE_FILE_COUNT,
  onVisibleFileCountChange,
  visibleOperationCounts,
  onVisibleOperationCountChange,
  firstRevealedFileIndex,
  firstRevealedFileRef,
  revealAnnouncement,
}: Pick<SessionFileChangesViewerProps, "result" | "loading" | "error"> & {
  visibleFileCount?: number;
  onVisibleFileCountChange?(count: number, announcement: string): void;
  visibleOperationCounts?: Readonly<Record<string, number>>;
  onVisibleOperationCountChange?(path: string, count: number): void;
  firstRevealedFileIndex?: number | null;
  firstRevealedFileRef?: Ref<HTMLButtonElement>;
  revealAnnouncement?: string;
}) {
  if (loading)
    return (
      <ChangeState title="Reading session changes" detail="Collecting recorded changes from the host." />
    );
  if (error) return <ChangeState title="Session changes unavailable" detail={error} alert />;
  if (!result)
    return (
      <ChangeState title="No session selected" detail="Select a session to inspect its recorded changes." />
    );
  if (result.state === "unavailable") {
    return (
      <ChangeState
        title="Session changes unavailable"
        detail={result.message ?? "The host could not read the recorded changes."}
        alert
      />
    );
  }
  const partialWarning =
    result.state === "partial" ? (
      <div className="session-changes-warning" role="alert">
        <strong>Some session changes are unavailable.</strong>
        <p>{result.message ?? "Showing the records that the host could collect."}</p>
      </div>
    ) : null;
  const files = aggregateSessionChangedFiles(result);
  if (files.length === 0) {
    return (
      <div className="session-changes-files">
        {partialWarning}
        <ChangeState
          title="No recorded file changes."
          detail={
            result.state === "partial"
              ? "No file changes were collected from the available session records."
              : "This session tree has no recorded edit or write operations."
          }
        />
      </div>
    );
  }
  const visibleFiles = files.slice(0, visibleFileCount);
  const remainingFileCount = files.length - visibleFiles.length;
  return (
    <div className="session-changes-files">
      {partialWarning}
      <p className="session-changes-summary">
        {formatSessionFileChangesSummary({
          fileCount: files.length,
          operationCount: result.operationCount,
        })}
      </p>
      {visibleFiles.map((file, index) => (
        <SessionChangedFileView
          file={file}
          key={file.path}
          {...(index === firstRevealedFileIndex && firstRevealedFileRef
            ? { triggerRef: firstRevealedFileRef }
            : {})}
          visibleOperationCount={visibleOperationCounts?.[file.path] ?? INITIAL_VISIBLE_OPERATION_COUNT}
          onVisibleOperationCountChange={(count) => onVisibleOperationCountChange?.(file.path, count)}
        />
      ))}
      {remainingFileCount > 0 ? (
        <Button
          className="session-changes-reveal"
          type="button"
          variant="ghost"
          onClick={() => {
            const nextVisibleFileCount = Math.min(files.length, visibleFileCount + FILE_REVEAL_COUNT);
            const revealedCount = nextVisibleFileCount - visibleFileCount;
            onVisibleFileCountChange?.(
              nextVisibleFileCount,
              `${revealedCount.toLocaleString()} more ${
                revealedCount === 1 ? "file" : "files"
              } shown. ${nextVisibleFileCount.toLocaleString()} files shown in total.`,
            );
          }}
        >
          Show {Math.min(FILE_REVEAL_COUNT, remainingFileCount)} more files (
          {remainingFileCount.toLocaleString()} remaining)
        </Button>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {revealAnnouncement}
      </p>
    </div>
  );
}

function SessionFileChangesContentWithReveal(
  props: Pick<SessionFileChangesViewerProps, "result" | "loading" | "error">,
) {
  const [visibleFileCount, setVisibleFileCount] = useState(INITIAL_VISIBLE_FILE_COUNT);
  const [visibleOperationCounts, setVisibleOperationCounts] = useState<Record<string, number>>({});
  const [revealAnnouncement, setRevealAnnouncement] = useState("");
  const firstRevealedFileIndexRef = useRef<number | null>(null);
  const firstRevealedFileRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (firstRevealedFileIndexRef.current === null) return;
    firstRevealedFileRef.current?.focus();
    firstRevealedFileIndexRef.current = null;
  }, [visibleFileCount]);

  return (
    <SessionFileChangesContent
      {...props}
      visibleFileCount={visibleFileCount}
      onVisibleFileCountChange={(count, announcement) => {
        firstRevealedFileIndexRef.current = visibleFileCount;
        setVisibleFileCount(count);
        setRevealAnnouncement(announcement);
      }}
      visibleOperationCounts={visibleOperationCounts}
      onVisibleOperationCountChange={(path, count) =>
        setVisibleOperationCounts((current) => ({ ...current, [path]: count }))
      }
      firstRevealedFileIndex={firstRevealedFileIndexRef.current}
      firstRevealedFileRef={firstRevealedFileRef}
      revealAnnouncement={revealAnnouncement}
    />
  );
}

function SessionChangedFileView({
  file,
  visibleOperationCount,
  onVisibleOperationCountChange,
  triggerRef,
}: {
  file: SessionChangedFile;
  visibleOperationCount: number;
  onVisibleOperationCountChange(count: number): void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const visibleOperations = file.operations.slice(0, visibleOperationCount);
  const remainingOperationCount = file.operations.length - visibleOperations.length;
  return (
    <Collapsible className="session-changes-file" defaultOpen={false}>
      <CollapsibleTrigger
        ref={triggerRef}
        type="button"
        className="session-changes-file-trigger"
        aria-label={`Toggle ${file.operations.length} recorded ${file.operations.length === 1 ? "operation" : "operations"} for ${file.path}`}
      >
        <span className="session-changes-file-heading">
          <svg className="session-changes-chevron" aria-hidden="true" viewBox="0 0 24 24">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <strong>{file.path}</strong>
        </span>
        <span className="session-changes-operation-count">{file.operations.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="session-changes-file-content">
        <ol className="session-changes-operations">
          {visibleOperations.map((operation, index) => (
            <OperationRow
              key={`${file.path}:${operation.sessionId}:${operation.timestamp}:${operation.type}:${index}`}
              filePath={file.path}
              operation={operation}
            />
          ))}
        </ol>
        {remainingOperationCount > 0 ? (
          <Button
            className="session-changes-reveal"
            type="button"
            variant="ghost"
            onClick={() =>
              onVisibleOperationCountChange(
                Math.min(file.operations.length, visibleOperationCount + OPERATION_REVEAL_COUNT),
              )
            }
          >
            Show {Math.min(OPERATION_REVEAL_COUNT, remainingOperationCount)} more operations (
            {remainingOperationCount.toLocaleString()} remaining)
          </Button>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function OperationRow({ filePath, operation }: { filePath: string; operation: SessionFileOperation }) {
  return (
    <li className="session-changes-operation">
      <div className="session-changes-operation-metadata">
        <Badge>{operation.type === "edit" ? (operation.op ?? "edit") : "write"}</Badge>
        <time dateTime={operation.timestamp}>{formatOperationTime(operation.timestamp)}</time>
        {operation.type === "edit" ? (
          <span className="session-changes-line-totals">
            <span className="sr-only">
              {operation.additions} additions, {operation.deletions} deletions
            </span>
            <span className="session-changes-additions" aria-hidden="true">
              +{operation.additions}
            </span>
            <span className="session-changes-deletions" aria-hidden="true">
              −{operation.deletions}
            </span>
          </span>
        ) : null}
      </div>
      {operation.type === "write" ? (
        <dl className="session-changes-write-metadata">
          <div>
            <dt>Resolved path</dt>
            <dd>{operation.resolvedPath}</dd>
          </div>
          <div>
            <dt>Bytes</dt>
            <dd>{operation.byteCount.toLocaleString()}</dd>
          </div>
        </dl>
      ) : operation.patch ? (
        <SessionPatch patch={operation.patch} filePath={filePath} operationTimestamp={operation.timestamp} />
      ) : (
        <p className="session-changes-patch-omitted">Patch data is unavailable for this recorded edit.</p>
      )}
    </li>
  );
}

function ChangeState({ title, detail, alert = false }: { title: string; detail: string; alert?: boolean }) {
  return (
    <div className="session-changes-state" role={alert ? "alert" : "status"}>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function SessionPatch({
  patch,
  filePath,
  operationTimestamp,
}: {
  patch: string;
  filePath: string;
  operationTimestamp: string;
}) {
  const lineCount = countPatchLines(patch);
  const lines = patch.split("\n", Math.min(lineCount, MAX_RENDERED_PATCH_LINES));
  const omittedLineCount = lineCount - lines.length;
  return (
    <section
      className="session-change-patch-scroll"
      aria-label={`Edit patch for ${filePath} at ${operationTimestamp}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The labelled horizontal scroll region needs a keyboard focus stop.
      tabIndex={0}
    >
      <pre className="session-change-patch">
        <code>
          {lines.map((line, index) => (
            <span
              className={`session-change-line session-change-line-${classifyPatchLine(line)}`}
              key={`${index}:${line}`}
            >
              {line || " "}
            </span>
          ))}
        </code>
      </pre>
      {omittedLineCount > 0 ? (
        <p className="session-changes-patch-omitted">
          {omittedLineCount.toLocaleString()} additional patch{" "}
          {omittedLineCount === 1 ? "line was" : "lines were"} omitted from this preview.
        </p>
      ) : null}
    </section>
  );
}

function countPatchLines(patch: string): number {
  let count = 1;
  for (let index = 0; index < patch.length; index += 1) {
    if (patch.charCodeAt(index) === 10) count += 1;
  }
  return patch.endsWith("\n") ? count - 1 : count;
}

function classifyPatchLine(line: string): "meta" | "added" | "removed" | "context" {
  if (
    /^(?:diff --git |index |--- |\+\+\+ |@@ |new file mode |deleted file mode |similarity index |rename from |rename to |Binary files |GIT binary patch|literal |delta |\\ No newline)/.test(
      line,
    )
  )
    return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

function formatOperationTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}
