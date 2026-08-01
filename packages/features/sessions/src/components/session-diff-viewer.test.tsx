import type { SessionWorkingTreeDiffResponse } from "@omp-remote/protocol";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  formatWorkingTreeMetadata,
  formatWorkingTreeSummary,
  SessionDiffContent,
  SessionDiffViewer,
  sessionDiffViewerLayout,
  UnifiedDiff,
} from "./session-diff-viewer.js";
import { Drawer } from "./ui/drawer.js";

const AVAILABLE: SessionWorkingTreeDiffResponse = {
  sessionId: "session-1",
  state: "available",
  root: "/work/project",
  files: [
    {
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
      patch: "@@ -1 +1,2 @@\n-old\n+new\n+line",
    },
  ],
  fileCount: 1,
  additions: 2,
  deletions: 1,
  changedLines: 3,
  message: null,
};

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  if (typeof node.type === "function") {
    const renderFunction = node.type as (props: { children?: ReactNode }) => ReactNode;
    return textContent(renderFunction(node.props));
  }
  return textContent(node.props.children);
}

function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<{ className?: string; children?: ReactNode }>) => boolean,
): ReactElement<{ className?: string; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return [];
  const descendants = findElements(node.props.children, predicate);
  return predicate(node) ? [node, ...descendants] : descendants;
}

describe("session diff metadata", () => {
  it("pluralizes file and changed-line counts", () => {
    expect(formatWorkingTreeSummary({ fileCount: 1, changedLines: 1 })).toBe("1 file · 1 changed line");
    expect(formatWorkingTreeSummary({ fileCount: 2, changedLines: 3 })).toBe("2 files · 3 changed lines");
  });

  it("uses explicit metadata labels for unavailable states and prioritizes host errors", () => {
    const unavailable = {
      ...AVAILABLE,
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
      changedLines: 0,
    };
    expect(formatWorkingTreeMetadata({ ...unavailable, state: "not_git" }, null)).toBe(
      "Not a Git repository",
    );
    expect(formatWorkingTreeMetadata({ ...unavailable, state: "oversized" }, null)).toBe("Diff too large");
    expect(formatWorkingTreeMetadata({ ...unavailable, state: "unavailable" }, null)).toBe(
      "Changes unavailable",
    );
    expect(formatWorkingTreeMetadata(AVAILABLE, "Host failed")).toBe("Changes unavailable");
  });
});

describe("SessionDiffViewer", () => {
  it("uses a right-side panel on desktop and delegates close changes", () => {
    const onOpenChange = vi.fn();
    const viewer = SessionDiffViewer({
      open: true,
      mobile: false,
      result: AVAILABLE,
      loading: false,
      error: null,
      onOpenChange,
    });
    expect(viewer.type).toBe(Drawer);
    expect(viewer.props).toMatchObject({ open: true, showSwipeHandle: false, swipeDirection: "right" });
    viewer.props.onOpenChange(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(textContent(SessionDiffContent({ result: AVAILABLE, loading: false, error: null }))).toContain(
      "src/app.ts",
    );
  });

  it("uses a swipeable bottom drawer on mobile", () => {
    expect(sessionDiffViewerLayout(true)).toEqual({ showSwipeHandle: true, swipeDirection: "down" });
    const viewer = SessionDiffViewer({
      open: true,
      mobile: true,
      result: AVAILABLE,
      loading: false,
      error: null,
      onOpenChange: vi.fn(),
    });
    expect(viewer.props).toMatchObject({ showSwipeHandle: true, swipeDirection: "down" });
  });

  it.each([
    ["loading", { result: null, loading: true, error: null }, "Reading working tree"],
    ["host error", { result: null, loading: false, error: "Host failed" }, "Host failed"],
  ])("renders the %s state", (_name, state, expected) => {
    expect(textContent(SessionDiffContent(state))).toContain(expected);
  });
});

describe("UnifiedDiff", () => {
  it("renders one block row per patch line without embedded newline text", () => {
    const rows = findElements(
      UnifiedDiff({ patch: "@@ -1 +1 @@\n-old\n+new\n" }),
      (element) => element.props.className?.includes("diff-line") === true,
    );
    expect(rows.map((row) => textContent(row))).toEqual(["@@ -1 +1 @@", "-old", "+new"]);
    expect(rows.every((row) => !textContent(row).includes("\n"))).toBe(true);
  });
});
