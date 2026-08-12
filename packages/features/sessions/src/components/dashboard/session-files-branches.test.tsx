import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import type { Session, SessionBranchTopology, SessionFileChangesResponse } from "@omp-remote/protocol";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionBranchSelector, type SessionBranchSelectorProps } from "../session-branch-selector.js";
import { SessionFileChangesViewer } from "../session-file-changes-viewer.js";

describe("dashboard session branch selector", () => {
  const TOPOLOGY: SessionBranchTopology = {
    sessionId: BASE_SESSION.id,
    currentBranch: BASE_SESSION.branch as string,
    branches: [
      { name: BASE_SESSION.branch as string, parent: "main" },
      { name: "feature/sibling", parent: "main" },
      { name: "main" },
    ],
  };

  function branchSelector(output: ReactNode): ReactElement<SessionBranchSelectorProps> {
    const selector = findElements(output, (element) => element.type === SessionBranchSelector)[0];
    if (!selector) throw new Error("Expected Dashboard to render SessionBranchSelector");
    return selector as unknown as ReactElement<SessionBranchSelectorProps>;
  }

  function metadata(output: ReactNode): ReactElement<Record<string, unknown>> {
    const element = findElements(output, (candidate) => candidate.props.className === "session-metadata")[0];
    if (!element) throw new Error("Expected Dashboard to render session metadata");
    return element;
  }

  function branchTrigger(output: ReactNode): ReactElement<Record<string, unknown>> | undefined {
    return findElements(output, (element) => element.props.className === "session-branch-trigger")[0];
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, reject, resolve };
  }

  async function settlePromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("moves Branch out of the header and into the first metadata position with the full long name", () => {
    const longBranch = `feature/${"nested-segment-".repeat(18)}`.slice(0, 255);
    const output = renderControlledDashboard(composerDashboardProps({ ...BASE_SESSION, branch: longBranch }));
    const header = findElements(output, (element) => element.props.className === "session-header")[0];
    const metadataElement = metadata(output);
    const labels = findElements(metadataElement, (element) => element.type === "dt");
    const value = findElements(
      metadataElement,
      (element) => element.props.className === "session-branch-value",
    )[0];

    expect(textContent(header)).not.toContain(longBranch);
    expect(labels.map((label) => textContent(label))[0]).toBe("Branch");
    expect(value?.props.title).toBe(longBranch);
    expect(textContent(value)).toBe(longBranch);
  });

  it("omits Branch metadata for non-Git or detached sessions", () => {
    const output = renderControlledDashboard(composerDashboardProps({ ...BASE_SESSION, branch: null }));

    expect(
      findElements(metadata(output), (element) => element.type === "dt").map((label) => textContent(label)),
    ).not.toContain("Branch");
    expect(branchTrigger(output)).toBeUndefined();
  });

  it.each([
    ["idle RPC", { source: "rpc", status: "idle", connected: true }],
    ["waiting extension", { source: "extension", status: "waiting", connected: true }],
    ["running", { source: "rpc", status: "running", connected: true }],
  ] as const)("offers the ghost viewer trigger for a connected %s session", (_label, sessionState) => {
    const session: Session = { ...BASE_SESSION, ...sessionState };
    const output = renderControlledDashboard(composerDashboardProps(session));

    expect(branchTrigger(output)?.props).toMatchObject({
      variant: "ghost",
      "aria-label": `Open branch viewer. Current branch ${session.branch}`,
    });
  });

  it.each([
    ["disconnected", { status: "disconnected", connected: false }],
    ["historical", { source: "history", status: "history", connected: false }],
  ] as const)("shows Branch without an interactive trigger for a %s session", (_label, sessionState) => {
    const session = { ...BASE_SESSION, ...sessionState } as Session;
    const output = renderControlledDashboard(composerDashboardProps(session));

    expect(textContent(metadata(output))).toContain(BASE_SESSION.branch as string);
    expect(branchTrigger(output)).toBeUndefined();
  });

  it("loads topology exactly once per open and resets before a fresh reopen", async () => {
    const onLoadSessionBranchTopology = vi.fn().mockResolvedValue(TOPOLOGY);
    const props = { ...composerDashboardProps(), onLoadSessionBranchTopology };
    let output = renderControlledDashboard(props);

    branchSelector(output).props.onOpenChange(true);
    branchSelector(output).props.onOpenChange(true);
    expect(onLoadSessionBranchTopology).toHaveBeenCalledTimes(1);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: TOPOLOGY,
      loading: false,
    });

    branchSelector(output).props.onOpenChange(false);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      query: "",
    });

    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    expect(onLoadSessionBranchTopology).toHaveBeenCalledTimes(2);
  });

  it("aborts and ignores a deferred topology result after close", async () => {
    const pending = deferred<SessionBranchTopology>();
    const onLoadSessionBranchTopology = vi.fn().mockReturnValue(pending.promise);
    const props = { ...composerDashboardProps(), onLoadSessionBranchTopology };
    let output = renderControlledDashboard(props);

    branchSelector(output).props.onOpenChange(true);
    const signal = onLoadSessionBranchTopology.mock.calls[0]?.[1] as AbortSignal;
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onOpenChange(false);
    pending.resolve(TOPOLOGY);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(signal.aborted).toBe(true);
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      loadError: null,
    });
  });

  it("prevents an old session load from replacing a newly selected session topology", async () => {
    const firstPending = deferred<SessionBranchTopology>();
    const secondSession: Session = {
      ...BASE_SESSION,
      id: "session-2",
      name: "Second",
      branch: "feature/second",
    };
    const secondTopology: SessionBranchTopology = {
      sessionId: secondSession.id,
      currentBranch: secondSession.branch as string,
      branches: [{ name: secondSession.branch as string }, { name: "main" }],
    };
    const onLoadSessionBranchTopology = vi
      .fn()
      .mockReturnValueOnce(firstPending.promise)
      .mockResolvedValueOnce(secondTopology);
    const firstProps = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadSessionBranchTopology,
    };
    let output = renderControlledDashboard(firstProps);

    branchSelector(output).props.onOpenChange(true);
    const firstSignal = onLoadSessionBranchTopology.mock.calls[0]?.[1] as AbortSignal;
    const secondProps = { ...firstProps, selectedSessionId: secondSession.id };
    output = renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(firstSignal.aborted).toBe(true);
    expect(branchSelector(output).props.open).toBe(false);

    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    firstPending.resolve(TOPOLOGY);
    await settlePromises();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });

    expect(onLoadSessionBranchTopology).toHaveBeenCalledTimes(2);
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: secondTopology,
      currentBranch: secondSession.branch,
    });
  });

  it("opens the viewer while running without allowing checkout", async () => {
    const onLoadSessionBranchTopology = vi.fn().mockResolvedValue(TOPOLOGY);
    const onSwitchBranch = vi.fn();
    const runningSession: Session = { ...BASE_SESSION, status: "running" };
    const props = {
      ...composerDashboardProps(runningSession),
      onLoadSessionBranchTopology,
      onSwitchBranch,
    };
    let output = renderControlledDashboard(props);

    (branchTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(onLoadSessionBranchTopology).toHaveBeenCalledWith(runningSession.id, expect.any(AbortSignal));
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      running: true,
      topology: TOPOLOGY,
    });

    branchSelector(output).props.onSelectBranch("feature/sibling");
    expect(onSwitchBranch).not.toHaveBeenCalled();
  });

  it("keeps the drawer open and disables checkout if the session starts running", async () => {
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();

    const runningProps = {
      ...props,
      sessions: [{ ...BASE_SESSION, status: "running" as const }],
    };
    output = renderControlledDashboard(runningProps, { preserveState: true });

    expect(branchSelector(output).props).toMatchObject({ open: true, running: true });
    expect(branchTrigger(output)).toBeDefined();
  });

  it("closes stale topology when the live session branch changes outside the selector", async () => {
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(branchSelector(output).props).toMatchObject({ open: true, topology: TOPOLOGY });

    const patchedProps = {
      ...props,
      sessions: [{ ...BASE_SESSION, branch: "feature/sibling" }],
    };
    output = renderControlledDashboard(patchedProps, { preserveState: true });
    output = renderControlledDashboard(patchedProps, {
      preserveState: true,
      effectsEnabled: false,
    });

    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      query: "",
    });
  });

  it.each([
    ["disconnects", { connected: false, status: "disconnected" }],
    ["becomes historical", { connected: false, source: "history", status: "history" }],
    ["loses its branch", { branch: null }],
  ] as const)("closes and resets when the selected session %s", async (_label, sessionState) => {
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(
      {
        ...props,
        sessions: [{ ...BASE_SESSION, ...sessionState } as Session],
      },
      { preserveState: true },
    );
    output = renderControlledDashboard(
      {
        ...props,
        sessions: [{ ...BASE_SESSION, ...sessionState } as Session],
      },
      { preserveState: true, effectsEnabled: false },
    );

    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      query: "",
      checkoutPending: null,
      checkoutError: null,
    });
  });

  it("retains query and pending state until checkout succeeds, then relies on the session patch", async () => {
    const checkout = deferred<void>();
    const onSwitchBranch = vi.fn().mockReturnValue(checkout.promise);
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
      onSwitchBranch,
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onQueryChange("sibling");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onSelectBranch("feature/sibling");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(onSwitchBranch).toHaveBeenCalledWith(BASE_SESSION.id, "feature/sibling");
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      query: "sibling",
      checkoutPending: "feature/sibling",
    });

    checkout.resolve();
    await settlePromises();
    const patchedProps = {
      ...props,
      sessions: [{ ...BASE_SESSION, branch: "feature/sibling" }],
    };
    output = renderControlledDashboard(patchedProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      query: "",
      checkoutPending: null,
    });
    expect(textContent(metadata(output))).toContain("feature/sibling");
  });

  it("keeps topology and query open while exposing the exact checkout failure", async () => {
    const exactError = "error: Your local changes would be overwritten by checkout";
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
      onSwitchBranch: vi.fn().mockRejectedValue(new Error(exactError)),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onQueryChange("sibling");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onSelectBranch("feature/sibling");
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: TOPOLOGY,
      query: "sibling",
      checkoutPending: null,
      checkoutError: exactError,
    });
    expect(textContent(metadata(output))).toContain(BASE_SESSION.branch as string);
  });

  it("drops pending checkout state and ignores its late error after session selection changes", async () => {
    const checkout = deferred<void>();
    const secondSession: Session = {
      ...BASE_SESSION,
      id: "session-2",
      branch: "feature/second",
    };
    const firstProps = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
      onSwitchBranch: vi.fn().mockReturnValue(checkout.promise),
    };
    let output = renderControlledDashboard(firstProps);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(firstProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    branchSelector(output).props.onSelectBranch("feature/sibling");
    output = renderControlledDashboard(firstProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props.checkoutPending).toBe("feature/sibling");

    const secondProps = { ...firstProps, selectedSessionId: secondSession.id };
    output = renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      checkoutPending: null,
      checkoutError: null,
    });

    checkout.reject(new Error("late checkout failure"));
    await settlePromises();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props.checkoutError).toBeNull();
  });

  it("keeps the exact topology source error in the open selector until close", async () => {
    const exactError = "Session branch topology could not be read";
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockRejectedValue(new Error(exactError)),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: null,
      loading: false,
      loadError: exactError,
    });
  });
});

describe("dashboard session-file-change refresh", () => {
  type FileChangesViewerProps = {
    open: boolean;
    result: SessionFileChangesResponse | null;
    loading: boolean;
    error: string | null;
    onOpenChange(open: boolean): void;
  };

  function changesFor(session: Session): SessionFileChangesResponse {
    return {
      sessionId: session.id,
      state: "available",
      sources: [
        {
          sessionId: session.id,
          root: session.cwd,
          files: [
            {
              path: `${session.cwd}/src/app.ts`,
              operations: [
                {
                  type: "edit",
                  timestamp: "2026-08-01T10:00:00.000Z",
                  sessionId: session.id,
                  op: "update",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -1 +1 @@\n-old\n+new",
                },
              ],
            },
          ],
        },
      ],
      fileCount: 1,
      operationCount: 1,
      additions: 1,
      deletions: 1,
      changedLines: 2,
      message: null,
    };
  }

  function fileChangesViewer(output: ReactNode): ReactElement<FileChangesViewerProps> {
    return findElements(
      output,
      (element) => element.type === SessionFileChangesViewer,
    )[0] as ReactElement<FileChangesViewerProps>;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it("ignores a deferred result after the drawer closes", async () => {
    vi.useFakeTimers();
    try {
      const pendingChanges = deferred<SessionFileChangesResponse>();
      const onLoadSessionFileChanges = vi.fn().mockReturnValue(pendingChanges.promise);
      const props = { ...composerDashboardProps(), onLoadSessionFileChanges };

      const output = renderControlledDashboard(props);
      const viewer = fileChangesViewer(output);
      viewer.props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      const signal = onLoadSessionFileChanges.mock.calls[0]?.[1] as AbortSignal;

      viewer.props.onOpenChange(false);
      pendingChanges.resolve(changesFor(BASE_SESSION));
      await vi.advanceTimersByTimeAsync(0);

      const closedOutput = renderControlledDashboard(props, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(signal.aborted).toBe(true);
      expect(fileChangesViewer(closedOutput).props).toMatchObject({
        open: false,
        result: null,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a deferred result after switching sessions", async () => {
    vi.useFakeTimers();
    try {
      const secondSession = {
        ...BASE_SESSION,
        id: "session-2",
        name: "Second session",
        lastActivity: "2026-07-28T18:00:00.000Z",
      };
      const pendingFirstChanges = deferred<SessionFileChangesResponse>();
      const secondChanges = changesFor(secondSession);
      const onLoadSessionFileChanges = vi
        .fn()
        .mockReturnValueOnce(pendingFirstChanges.promise)
        .mockResolvedValueOnce(secondChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      const firstSignal = onLoadSessionFileChanges.mock.calls[0]?.[1] as AbortSignal;

      const switchedProps = {
        ...firstProps,
        sessions: [BASE_SESSION, secondSession],
        selectedSessionId: secondSession.id,
      };
      renderControlledDashboard(switchedProps, { preserveState: true });
      await vi.advanceTimersByTimeAsync(750);
      pendingFirstChanges.resolve(changesFor(BASE_SESSION));
      await vi.advanceTimersByTimeAsync(0);

      output = renderControlledDashboard(switchedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(firstSignal.aborted).toBe(true);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);
      expect(fileChangesViewer(output).props).toMatchObject({
        result: secondChanges,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads on demand and preserves matching metadata without rescanning while closed", async () => {
    vi.useFakeTimers();
    try {
      const successfulChanges = changesFor(BASE_SESSION);
      const onLoadSessionFileChanges = vi.fn().mockResolvedValue(successfulChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      await vi.advanceTimersByTimeAsync(750);
      expect(onLoadSessionFileChanges).not.toHaveBeenCalled();

      let viewer = fileChangesViewer(output);
      viewer.props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
      viewer = fileChangesViewer(output);
      expect(viewer.props).toMatchObject({
        open: true,
        result: successfulChanges,
        loading: false,
        error: null,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      viewer.props.onOpenChange(false);
      const laterSession = { ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" };
      const laterProps = { ...firstProps, sessions: [laterSession] };
      renderControlledDashboard(laterProps, { preserveState: true });
      await vi.advanceTimersByTimeAsync(750);
      output = renderControlledDashboard(laterProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      viewer = fileChangesViewer(output);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);
      expect(viewer.props).toMatchObject({
        open: false,
        result: successfulChanges,
        loading: false,
        error: null,
      });
      expect(textContent(output)).toContain("1 file · 1 operation");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the matching result visible during a deferred same-session refresh", async () => {
    vi.useFakeTimers();
    try {
      const initialChanges = changesFor(BASE_SESSION);
      const refreshedChanges = {
        ...initialChanges,
        operationCount: 2,
        additions: 2,
        changedLines: 3,
      };
      const pendingRefresh = deferred<SessionFileChangesResponse>();
      const onLoadSessionFileChanges = vi
        .fn()
        .mockResolvedValueOnce(initialChanges)
        .mockReturnValueOnce(pendingRefresh.promise);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);

      const refreshedProps = {
        ...firstProps,
        sessions: [{ ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" }],
      };
      renderControlledDashboard(refreshedProps, { preserveState: true });
      output = renderControlledDashboard(refreshedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(fileChangesViewer(output).props).toMatchObject({
        result: initialChanges,
        loading: true,
        error: null,
      });

      await vi.advanceTimersByTimeAsync(750);
      output = renderControlledDashboard(refreshedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);
      expect(fileChangesViewer(output).props).toMatchObject({
        result: initialChanges,
        loading: true,
        error: null,
      });

      pendingRefresh.resolve(refreshedChanges);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(refreshedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(fileChangesViewer(output).props).toMatchObject({
        result: refreshedChanges,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows loading and suppresses the previous result during a debounced open-drawer switch", async () => {
    vi.useFakeTimers();
    try {
      const secondSession = {
        ...BASE_SESSION,
        id: "session-2",
        name: "Second session",
        lastActivity: "2026-07-28T18:00:00.000Z",
      };
      const firstChanges = changesFor(BASE_SESSION);
      const secondChanges = changesFor(secondSession);
      const onLoadSessionFileChanges = vi
        .fn()
        .mockResolvedValueOnce(firstChanges)
        .mockResolvedValueOnce(secondChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
      expect(fileChangesViewer(output).props.result).toBe(firstChanges);

      const switchedProps = {
        ...firstProps,
        sessions: [BASE_SESSION, secondSession],
        selectedSessionId: secondSession.id,
      };
      output = renderControlledDashboard(switchedProps, { preserveState: true });
      expect(fileChangesViewer(output).props).toMatchObject({
        open: true,
        result: null,
        loading: true,
        error: null,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(749);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      output = renderControlledDashboard(switchedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);
      expect(onLoadSessionFileChanges.mock.calls[1]?.[0]).toBe(secondSession.id);
      expect(fileChangesViewer(output).props).toMatchObject({
        result: secondChanges,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels scheduled refreshes on close without disrupting an immediate quick-reopen load", async () => {
    vi.useFakeTimers();
    try {
      const successfulChanges = changesFor(BASE_SESSION);
      const onLoadSessionFileChanges = vi.fn().mockResolvedValue(successfulChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      const firstActivityProps = {
        ...firstProps,
        sessions: [{ ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" }],
      };
      output = renderControlledDashboard(firstActivityProps, { preserveState: true });
      fileChangesViewer(output).props.onOpenChange(false);
      await vi.advanceTimersByTimeAsync(750);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);

      const secondActivityProps = {
        ...firstProps,
        sessions: [{ ...BASE_SESSION, lastActivity: "2026-07-28T19:00:00.000Z" }],
      };
      output = renderControlledDashboard(secondActivityProps, { preserveState: true });
      const viewer = fileChangesViewer(output);
      viewer.props.onOpenChange(false);
      viewer.props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(3);
      const quickReopenSignal = onLoadSessionFileChanges.mock.calls[2]?.[1] as AbortSignal;

      await vi.advanceTimersByTimeAsync(750);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(3);
      expect(quickReopenSignal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears successful counts when an open-drawer refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const successfulChanges = changesFor(BASE_SESSION);
      const onLoadSessionFileChanges = vi
        .fn()
        .mockResolvedValueOnce(successfulChanges)
        .mockRejectedValueOnce(new Error("Host refresh failed"));
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
      expect(fileChangesViewer(output).props.result).toBe(successfulChanges);

      const laterSession = { ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" };
      const laterProps = { ...firstProps, sessions: [laterSession] };
      renderControlledDashboard(laterProps, { preserveState: true });
      await vi.advanceTimersByTimeAsync(750);
      output = renderControlledDashboard(laterProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(fileChangesViewer(output).props).toMatchObject({
        result: null,
        loading: false,
        error: "Host refresh failed",
      });
      expect(textContent(output)).toContain("Changes unavailable");
      expect(textContent(output)).not.toContain("1 file · 1 operation");
    } finally {
      vi.useRealTimers();
    }
  });
});
