import type { SessionFileChangesResponse } from "@omp-remote/protocol";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  aggregateSessionChangedFiles,
  formatSessionFileChangesMetadata,
  formatSessionFileChangesSummary,
  SessionFileChangesContent,
  SessionFileChangesViewer,
  sessionFileChangesViewerLayout,
  SessionPatch,
} from "./session-file-changes-viewer.js";
import { Drawer } from "./ui/drawer.js";

const AVAILABLE: SessionFileChangesResponse = {
  sessionId: "root-session",
  state: "available",
  sources: [
    {
      sessionId: "root-session",
      root: "/worktrees/root-project-with-a-very-long-label",
      files: [
        {
          path: "/worktrees/root-project-with-a-very-long-label/src/shared.ts",
          operations: [
            {
              type: "edit",
              timestamp: "2026-08-01T10:00:00.000Z",
              sessionId: "root-session",
              op: "update",
              patch: "@@ -1 +1 @@\n-old\n+new",
              additions: 1,
              deletions: 1,
            },
            {
              type: "write",
              timestamp: "2026-08-01T10:01:00.000Z",
              sessionId: "root-session",
              resolvedPath: "/worktrees/root-project-with-a-very-long-label/src/shared.ts",
              byteCount: 42,
            },
          ],
        },
      ],
    },
    {
      sessionId: "child-session",
      root: "/worktrees/child-project",
      files: [
        {
          path: "/worktrees/child-project/src/shared.ts",
          operations: [
            {
              type: "edit",
              timestamp: "2026-08-01T10:02:00.000Z",
              sessionId: "child-session",
              additions: 0,
              deletions: 0,
            },
          ],
        },
      ],
    },
  ],
  fileCount: 2,
  operationCount: 3,
  additions: 1,
  deletions: 1,
  changedLines: 2,
  message: null,
};

type TestProps = {
  className?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  role?: string;
  tabIndex?: number;
  "aria-label"?: string;
  "aria-hidden"?: boolean | "true";
  render?: ReactElement<TestProps>;
  ref?: unknown;
  "aria-live"?: string;
  title?: string;
  onClick?: () => void;
};

function renderOwnedComponents(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(renderOwnedComponents);
  if (!isValidElement<TestProps>(node)) return node;
  if (
    typeof node.type === "function" &&
    ["SessionChangedFileView", "OperationRow", "ChangeState"].includes(node.type.name)
  ) {
    return renderOwnedComponents((node.type as (props: TestProps) => ReactNode)(node.props));
  }
  return {
    ...node,
    props: { ...node.props, children: renderOwnedComponents(node.props.children) },
  } as ReactElement<TestProps>;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement<TestProps>(node)) return "";
  return textContent(node.props.children);
}

function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<TestProps>) => boolean,
): ReactElement<TestProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement<TestProps>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...findElements(node.props.children, predicate)];
}

describe("session file changes metadata", () => {
  it("reports unique file and operation counts with correct labels", () => {
    expect(formatSessionFileChangesSummary({ fileCount: 1, operationCount: 1 })).toBe("1 file · 1 operation");
    expect(formatSessionFileChangesSummary(AVAILABLE)).toBe("2 files · 3 operations");
    expect(formatSessionFileChangesMetadata(AVAILABLE, null)).toBe("2 files · 3 operations");
    expect(formatSessionFileChangesMetadata(AVAILABLE, null, true)).toBe("Reading changes…");
    expect(formatSessionFileChangesMetadata({ ...AVAILABLE, state: "partial" }, null)).toBe(
      "Partial · 2 files · 3 operations",
    );
    expect(formatSessionFileChangesMetadata(AVAILABLE, "Host failed")).toBe("Changes unavailable");
    expect(formatSessionFileChangesMetadata(null, null)).toBe("View changes");
    expect(formatSessionFileChangesMetadata(null, null, true)).toBe("Reading changes…");
  });
});

describe("SessionFileChangesViewer", () => {
  it("preserves desktop-right and mobile-bottom drawer behavior and close delegation", () => {
    const onOpenChange = vi.fn();
    const desktop = SessionFileChangesViewer({
      open: true,
      mobile: false,
      result: AVAILABLE,
      loading: false,
      error: null,
      onOpenChange,
    });
    expect(desktop.type).toBe(Drawer);
    expect(desktop.props).toMatchObject({ showSwipeHandle: false, swipeDirection: "right" });
    desktop.props.onOpenChange(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(sessionFileChangesViewerLayout(true)).toEqual({
      showSwipeHandle: true,
      swipeDirection: "down",
    });
  });

  it("labels the drawer and close control for assistive technology", () => {
    const viewer = renderOwnedComponents(
      SessionFileChangesViewer({
        open: true,
        mobile: true,
        result: AVAILABLE,
        loading: false,
        error: null,
        onOpenChange: vi.fn(),
      }),
    );
    expect(textContent(viewer)).toContain("Session file changes");
    const close = findElements(
      viewer,
      (element) => typeof element.type === "function" && element.type.name === "DrawerClose",
    )[0];
    expect(close?.props.render?.props["aria-label"]).toBe("Close session file changes");
  });
});

describe("SessionFileChangesContent", () => {
  const emptyWithReadableSource: SessionFileChangesResponse = {
    ...AVAILABLE,
    sources: AVAILABLE.sources.slice(0, 1).map((source) => ({ ...source, files: [] })),
    fileCount: 0,
    operationCount: 0,
    additions: 0,
    deletions: 0,
    changedLines: 0,
  };

  it.each([
    ["loading", { result: null, loading: true, error: null }, "Reading session changes"],
    [
      "empty readable source",
      { result: emptyWithReadableSource, loading: false, error: null },
      "No recorded file changes.",
    ],
    ["request error", { result: null, loading: false, error: "Host refresh failed" }, "Host refresh failed"],
    [
      "unavailable",
      {
        result: {
          ...AVAILABLE,
          state: "unavailable",
          sources: [],
          fileCount: 0,
          operationCount: 0,
          additions: 0,
          deletions: 0,
          changedLines: 0,
          message: "History missing",
        },
        loading: false,
        error: null,
      },
      "History missing",
    ],
  ])("renders the %s state", (_name, props, expected) => {
    expect(textContent(renderOwnedComponents(SessionFileChangesContent(props as never)))).toContain(expected);
  });
  it("keeps a valid result rendered during background loading", () => {
    const content = renderOwnedComponents(
      SessionFileChangesContent({ result: AVAILABLE, loading: true, error: null }),
    );
    const text = textContent(content);
    expect(text).toContain("2 files · 3 operations");
    expect(text).toContain("/worktrees/root-project-with-a-very-long-label/src/shared.ts");
    expect(text).not.toContain("Reading session changes");
  });

  it("shows partial warnings before the collected flat file list", () => {
    const content = renderOwnedComponents(
      SessionFileChangesContent({
        result: { ...AVAILABLE, state: "partial", message: "One source exceeded collection limits" },
        loading: false,
        error: null,
      }),
    );
    const text = textContent(content);
    expect(text.indexOf("Some session changes are unavailable.")).toBeLessThan(
      text.indexOf("/worktrees/root-project-with-a-very-long-label/src/shared.ts"),
    );
    expect(text).not.toContain("Root");
    expect(text).not.toContain("Descendant");
    expect(text).not.toContain("root-session");
    expect(text).not.toContain("child-session");
  });

  it("shows the partial warning before the empty state when no records were collected", () => {
    const content = renderOwnedComponents(
      SessionFileChangesContent({
        result: {
          ...emptyWithReadableSource,
          state: "partial",
          message: "The descendant source exceeded collection limits",
        },
        loading: false,
        error: null,
      }),
    );
    const text = textContent(content);
    expect(text).toContain("The descendant source exceeded collection limits");
    expect(text).toContain("No file changes were collected from the available session records.");
    expect(text).not.toContain("This session tree has no recorded edit or write operations.");
    expect(text.indexOf("Some session changes are unavailable.")).toBeLessThan(
      text.indexOf("No recorded file changes."),
    );
  });

  it("keeps different absolute worktree paths separate and collapsed initially", () => {
    const content = renderOwnedComponents(
      SessionFileChangesContent({ result: AVAILABLE, loading: false, error: null }),
    );
    const collapsibles = findElements(
      content,
      (element) => typeof element.type === "function" && element.type.name === "Collapsible",
    );
    expect(collapsibles).toHaveLength(2);
    expect(collapsibles.every((element) => element.props.defaultOpen === false)).toBe(true);
    expect(textContent(content)).toContain("/worktrees/root-project-with-a-very-long-label/src/shared.ts");
    expect(textContent(content)).toContain("/worktrees/child-project/src/shared.ts");
  });

  it("mounts file rows in progressively revealed batches", () => {
    const fileCount = 2_000;
    const manyFiles: SessionFileChangesResponse = {
      ...AVAILABLE,
      sources: [
        {
          sessionId: "root-session",
          root: "/worktrees/root-project",
          files: Array.from({ length: fileCount }, (_, index) => ({
            path: `/worktrees/root-project/src/file-${index}.ts`,
            operations: [
              {
                type: "edit" as const,
                timestamp: "2026-08-01T10:00:00.000Z",
                sessionId: "root-session",
                additions: 0,
                deletions: 0,
              },
            ],
          })),
        },
      ],
      fileCount,
      operationCount: fileCount,
    };
    const onVisibleFileCountChange = vi.fn();
    const initial = renderOwnedComponents(
      SessionFileChangesContent({
        result: manyFiles,
        loading: false,
        error: null,
        visibleFileCount: 50,
        onVisibleFileCountChange,
      }),
    );
    expect(
      findElements(
        initial,
        (element) => typeof element.type === "function" && element.type.name === "Collapsible",
      ),
    ).toHaveLength(50);
    const reveal = findElements(
      initial,
      (element) => element.props.className === "session-changes-reveal",
    )[0];
    expect(textContent(reveal)).toBe(`Show 50 more files (${(fileCount - 50).toLocaleString()} remaining)`);
    reveal?.props.onClick?.();
    expect(onVisibleFileCountChange).toHaveBeenCalledWith(
      100,
      "50 more files shown. 100 files shown in total.",
    );

    const firstRevealedFileRef = { current: null };
    const nextBatch = renderOwnedComponents(
      SessionFileChangesContent({
        result: manyFiles,
        loading: false,
        error: null,
        visibleFileCount: 100,
        onVisibleFileCountChange,
        firstRevealedFileIndex: 50,
        firstRevealedFileRef,
        revealAnnouncement: "50 more files shown. 100 files shown in total.",
      }),
    );
    expect(
      findElements(
        nextBatch,
        (element) => typeof element.type === "function" && element.type.name === "Collapsible",
      ),
    ).toHaveLength(100);
    const triggers = findElements(
      nextBatch,
      (element) => element.props.className === "session-changes-file-trigger",
    );
    expect(triggers[50]?.props.ref).toBe(firstRevealedFileRef);
    const liveRegion = findElements(nextBatch, (element) => element.props["aria-live"] === "polite")[0];
    expect(textContent(liveRegion)).toBe("50 more files shown. 100 files shown in total.");
  });

  it("mounts operations in progressively revealed batches", () => {
    const operationCount = 4_000;
    const path = "/worktrees/root-project/src/cumulative.ts";
    const manyOperations: SessionFileChangesResponse = {
      ...AVAILABLE,
      sources: [
        {
          sessionId: "root-session",
          root: "/worktrees/root-project",
          files: [
            {
              path,
              operations: Array.from({ length: operationCount }, (_, index) => ({
                type: "edit" as const,
                timestamp: `2026-08-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
                sessionId: "root-session",
                additions: 0,
                deletions: 0,
              })),
            },
          ],
        },
      ],
      fileCount: 1,
      operationCount,
    };
    const onVisibleOperationCountChange = vi.fn();
    const content = renderOwnedComponents(
      SessionFileChangesContent({
        result: manyOperations,
        loading: false,
        error: null,
        visibleOperationCounts: { [path]: 50 },
        onVisibleOperationCountChange,
      }),
    );

    expect(
      findElements(content, (element) => element.props.className === "session-changes-operation"),
    ).toHaveLength(50);
    const reveal = findElements(
      content,
      (element) =>
        element.props.className === "session-changes-reveal" &&
        textContent(element).includes("more operations"),
    )[0];
    expect(textContent(reveal)).toBe(
      `Show 50 more operations (${(operationCount - 50).toLocaleString()} remaining)`,
    );
    reveal?.props.onClick?.();
    expect(onVisibleOperationCountChange).toHaveBeenCalledWith(path, 100);
  });

  it("combines the same absolute path across sources into one chronological cumulative file", () => {
    const cumulative: SessionFileChangesResponse = {
      ...AVAILABLE,
      sources: [
        ...AVAILABLE.sources.slice(0, 1),
        {
          sessionId: "child-session",
          root: "/worktrees/root-project-with-a-very-long-label",
          files: [
            {
              path: "/worktrees/root-project-with-a-very-long-label/src/shared.ts",
              operations: [
                {
                  type: "edit",
                  timestamp: "2026-08-01T09:59:00.000Z",
                  sessionId: "child-session",
                  op: "create",
                  additions: 0,
                  deletions: 0,
                },
              ],
            },
          ],
        },
      ],
      fileCount: 2,
      operationCount: 3,
    };
    const files = aggregateSessionChangedFiles(cumulative);
    expect(files).toHaveLength(1);
    expect(files[0]?.operations.map((operation) => operation.sessionId)).toEqual([
      "child-session",
      "root-session",
      "root-session",
    ]);
    expect(formatSessionFileChangesMetadata(cumulative, null)).toBe("1 file · 3 operations");

    const content = renderOwnedComponents(
      SessionFileChangesContent({ result: cumulative, loading: false, error: null }),
    );
    const collapsibles = findElements(
      content,
      (element) => typeof element.type === "function" && element.type.name === "Collapsible",
    );
    expect(collapsibles).toHaveLength(1);
    expect(collapsibles[0]?.props.defaultOpen).toBe(false);
    const text = textContent(content);
    expect(text).toContain("1 file · 3 operations");
    expect(text).not.toContain("Root");
    expect(text).not.toContain("Descendant");
    expect(text).not.toContain("root-session");
    expect(text).not.toContain("child-session");
  });

  it("sorts fractional timestamps by epoch while preserving equal-time source order", () => {
    const fractional: SessionFileChangesResponse = {
      ...AVAILABLE,
      sources: [
        {
          sessionId: "root-session",
          root: "/worktrees/root-project",
          files: [
            {
              path: "/worktrees/root-project/src/fractional.ts",
              operations: [
                {
                  type: "edit",
                  timestamp: "2026-08-01T10:00:00.1Z",
                  sessionId: "equal-first",
                  additions: 0,
                  deletions: 0,
                },
                {
                  type: "edit",
                  timestamp: "2026-08-01T10:00:00.100Z",
                  sessionId: "equal-second",
                  additions: 0,
                  deletions: 0,
                },
                {
                  type: "edit",
                  timestamp: "2026-08-01T10:00:00.09Z",
                  sessionId: "fractional-earlier",
                  additions: 0,
                  deletions: 0,
                },
              ],
            },
          ],
        },
      ],
      fileCount: 1,
      operationCount: 3,
    };

    expect(
      aggregateSessionChangedFiles(fractional)[0]?.operations.map((operation) => operation.sessionId),
    ).toEqual(["fractional-earlier", "equal-first", "equal-second"]);
  });

  it("renders chronological edit/write metadata without write content", () => {
    const content = renderOwnedComponents(
      SessionFileChangesContent({ result: AVAILABLE, loading: false, error: null }),
    );
    const text = textContent(content);
    expect(text.indexOf("update")).toBeLessThan(text.indexOf("write"));
    expect(text).toContain("+1−1");
    expect(text).toContain("Resolved path");
    expect(text).toContain("42");
    expect(text).not.toContain("secret file contents");
    expect(text).toContain("Patch data is unavailable for this recorded edit.");
    const lineTotals = findElements(
      content,
      (element) => element.props.className === "session-changes-line-totals",
    )[0];
    expect(
      findElements(lineTotals, (element) => element.props.className === "sr-only").map(textContent),
    ).toEqual(["1 additions, 1 deletions"]);
    expect(
      findElements(
        lineTotals,
        (element) =>
          element.props.className === "session-changes-additions" ||
          element.props.className === "session-changes-deletions",
      ).every((element) => element.props["aria-hidden"] === "true"),
    ).toBe(true);
  });
});

describe("SessionPatch", () => {
  it("keeps patch markers, line classes, horizontal keyboard access, and no embedded newlines", () => {
    const patch = SessionPatch({
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      filePath: "/worktrees/root-project/src/app.ts",
      operationTimestamp: "2026-08-01T10:00:00.000Z",
    });
    expect(patch.props).toMatchObject({
      tabIndex: 0,
      "aria-label": "Edit patch for /worktrees/root-project/src/app.ts at 2026-08-01T10:00:00.000Z",
    });
    const pre = findElements(patch, (element) => element.props.className === "session-change-patch")[0];
    expect(pre?.props).not.toHaveProperty("tabIndex");
    expect(pre?.props).not.toHaveProperty("aria-label");
    const rows = findElements(
      patch,
      (element) => element.props.className?.includes("session-change-line-") === true,
    );
    expect(rows.map(textContent)).toEqual(["@@ -1 +1 @@", "-old", "+new"]);
    expect(rows.map((row) => row.props.className)).toEqual([
      "session-change-line session-change-line-meta",
      "session-change-line session-change-line-removed",
      "session-change-line session-change-line-added",
    ]);
  });

  it("gives each patch region a path-and-time label", () => {
    const first = SessionPatch({
      patch: "+first",
      filePath: "/worktrees/root-project/src/first.ts",
      operationTimestamp: "2026-08-01T10:00:00.000Z",
    });
    const second = SessionPatch({
      patch: "+second",
      filePath: "/worktrees/root-project/src/second.ts",
      operationTimestamp: "2026-08-01T10:00:01.000Z",
    });

    expect([first.props["aria-label"], second.props["aria-label"]]).toEqual([
      "Edit patch for /worktrees/root-project/src/first.ts at 2026-08-01T10:00:00.000Z",
      "Edit patch for /worktrees/root-project/src/second.ts at 2026-08-01T10:00:01.000Z",
    ]);
  });

  it("caps rendered patch line nodes and reports omitted lines", () => {
    const patch = SessionPatch({
      patch: Array.from({ length: 650 }, (_, index) => `+line ${index}`).join("\n"),
      filePath: "/worktrees/root-project/src/large.ts",
      operationTimestamp: "2026-08-01T10:00:00.000Z",
    });
    const rows = findElements(
      patch,
      (element) => element.props.className?.includes("session-change-line-") === true,
    );

    expect(rows).toHaveLength(500);
    expect(textContent(patch)).toContain("150 additional patch lines were omitted from this preview.");
    expect(patch.props).toMatchObject({ tabIndex: 0 });
  });
});
