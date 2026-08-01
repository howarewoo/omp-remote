import type { SessionWorkingTreeDiffResponse, WorkingTreeDiffFile } from "@omp-remote/protocol";
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

interface SessionDiffViewerProps {
  open: boolean;
  mobile: boolean;
  result: SessionWorkingTreeDiffResponse | null;
  loading: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
}

const STATUS_LABEL: Record<WorkingTreeDiffFile["status"], string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  untracked: "Untracked",
  type_changed: "Type changed",
  unknown: "Changed",
};

export function formatWorkingTreeSummary(counts: { fileCount: number; changedLines: number }): string {
  return `${counts.fileCount} ${counts.fileCount === 1 ? "file" : "files"} · ${counts.changedLines} changed ${counts.changedLines === 1 ? "line" : "lines"}`;
}

export function formatWorkingTreeMetadata(
  result: SessionWorkingTreeDiffResponse | null,
  error: string | null,
): string {
  if (error) return "Changes unavailable";
  if (!result) return "Reading changes…";
  if (result.state === "available") return formatWorkingTreeSummary(result);
  if (result.state === "not_git") return "Not a Git repository";
  if (result.state === "oversized") return "Diff too large";
  return "Changes unavailable";
}

export function sessionDiffViewerLayout(mobile: boolean) {
  return mobile
    ? ({ showSwipeHandle: true, swipeDirection: "down" } as const)
    : ({ showSwipeHandle: false, swipeDirection: "right" } as const);
}

/** Shows host-authoritative, uncommitted repository changes for the selected session. */
export function SessionDiffViewer({
  open,
  mobile,
  result,
  loading,
  error,
  onOpenChange,
}: SessionDiffViewerProps) {
  const layout = sessionDiffViewerLayout(mobile);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...layout}>
      <DrawerContent className="session-diff-panel">
        <DrawerHeader className="subagent-session-header session-diff-header">
          <div>
            <DrawerTitle>Working tree changes</DrawerTitle>
            <DrawerDescription>
              {result?.root ?? "Uncommitted changes in the selected session repository"}
            </DrawerDescription>
          </div>
          <DrawerClose
            className="session-diff-close"
            render={
              <Button type="button" variant="ghost" size="icon" aria-label="Close working tree changes" />
            }
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </DrawerClose>
        </DrawerHeader>
        <div className="session-diff-body" aria-busy={loading}>
          <SessionDiffContent result={result} loading={loading} error={error} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
export function SessionDiffContent({
  result,
  loading,
  error,
}: Pick<SessionDiffViewerProps, "result" | "loading" | "error">) {
  if (loading)
    return <DiffState title="Reading working tree" detail="Collecting current changes from the host." />;
  if (error) return <DiffState title="Working tree unavailable" detail={error} alert />;
  if (!result)
    return <DiffState title="Select a session" detail="Choose a session to inspect its working tree." />;
  if (result.state !== "available") {
    const title =
      result.state === "not_git"
        ? "Not a Git repository"
        : result.state === "oversized"
          ? "Diff is too large to display"
          : "Working tree unavailable";
    return <DiffState title={title} detail={result.message ?? "The host could not read these changes."} />;
  }
  if (result.files.length === 0) {
    return <DiffState title="No uncommitted changes" detail="The repository working tree matches HEAD." />;
  }
  return (
    <div className="session-diff-files">
      <p className="session-diff-summary">{formatWorkingTreeSummary(result)}</p>
      {result.files.map((file) => (
        <Collapsible
          className="session-diff-file"
          defaultOpen={false}
          key={`${file.oldPath ?? ""}:${file.path}`}
        >
          <CollapsibleTrigger
            type="button"
            className="session-diff-file-trigger"
            aria-label={`Toggle changes for ${file.path}`}
          >
            <span className="session-diff-file-heading">
              <svg className="session-diff-chevron" aria-hidden="true" viewBox="0 0 24 24">
                <path d="m9 18 6-6-6-6" />
              </svg>
              <span className="session-diff-file-paths">
                <strong>{file.path}</strong>
                {file.oldPath ? <span className="session-diff-old-path">from {file.oldPath}</span> : null}
              </span>
            </span>
            <span className="session-diff-file-stats">
              <span>{STATUS_LABEL[file.status]}</span>
              <span className="session-diff-additions">+{file.additions}</span>
              <span className="session-diff-deletions">−{file.deletions}</span>
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="session-diff-file-content">
            {file.binary ? (
              <p className="session-diff-binary">Binary file — a textual patch is not available.</p>
            ) : (
              <UnifiedDiff patch={file.patch} />
            )}
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

function DiffState({ title, detail, alert = false }: { title: string; detail: string; alert?: boolean }) {
  return (
    <div className="session-diff-state" role={alert ? "alert" : "status"}>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function UnifiedDiff({ patch }: { patch: string }) {
  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  return (
    <pre className="session-unified-diff">
      <code>
        {lines.map((line, index) => (
          <span className={`diff-line diff-${classifyDiffLine(line)}`} key={`${index}:${line}`}>
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

function classifyDiffLine(line: string): "meta" | "added" | "removed" | "context" {
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
