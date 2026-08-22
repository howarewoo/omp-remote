import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  getMessageScrollerHarness,
  renderControlledDashboard,
  renderTranscriptNodes,
  SELECT_ASK,
  textContent,
} from "./dashboard-test-support.js";
import type { Session } from "@omp-remote/protocol";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatWorkingLabel, MessageScrollerScrollController, WorkingIndicator } from "../dashboard.js";
import { SubagentSessionViewer } from "../subagent-session-viewer.js";
import { Button } from "../ui/button.js";
import {
  MessageScrollerButton,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "../ui/message-scroller.js";
const messageScrollerHarness = getMessageScrollerHarness();

describe("dashboard working status", () => {
  it("appends an announced Working status only to a running main transcript", () => {
    const runningOutput = renderControlledDashboard(
      composerDashboardProps({ ...BASE_SESSION, status: "running" }),
    );
    const runningTranscript = findElements(
      runningOutput,
      (element) => element.props.className === "transcript",
    )[0];

    const runningWorkingRows = findElements(
      runningTranscript,
      (element) => element.type === MessageScrollerItem && element.props.messageId === "working:session-1",
    );
    const runningIndicator = findElements(
      runningWorkingRows[0],
      (element) => element.type === WorkingIndicator,
    )[0];
    expect(
      renderTranscriptNodes(runningIndicator).filter(
        (node) => node.className === "ui-badge working-indicator",
      ),
    ).toEqual([expect.objectContaining({ text: "Working" })]);
    expect(runningWorkingRows).toHaveLength(1);
    expect((WorkingIndicator({ status: "running" }) as ReactElement<{ role?: string }>).props.role).toBe(
      "status",
    );

    const idleOutput = renderControlledDashboard(composerDashboardProps());
    const idleTranscript = findElements(idleOutput, (element) => element.props.className === "transcript")[0];
    expect(findElements(idleTranscript, (element) => element.type === WorkingIndicator)).toHaveLength(0);
    expect(
      findElements(
        idleTranscript,
        (element) => element.type === MessageScrollerItem && element.props.messageId === "working:session-1",
      ),
    ).toHaveLength(0);
  });

  it("suppresses the Working status when a running session has an active ask", () => {
    const runningWithAskOutput = renderControlledDashboard({
      ...composerDashboardProps({ ...BASE_SESSION, status: "running" }),
      askRequests: [SELECT_ASK],
    });
    const transcript = findElements(
      runningWithAskOutput,
      (element) => element.props.className === "transcript",
    )[0];

    expect(findElements(transcript, (element) => element.type === WorkingIndicator)).toHaveLength(0);
    const workingRows = findElements(
      transcript,
      (element) => element.type === MessageScrollerItem && element.props.messageId === "working:session-1",
    );
    expect(workingRows).toHaveLength(1);
    expect(workingRows[0]?.props.hidden).toBe(true);
  });

  it("appends the same Working status to a viewed running subagent transcript", () => {
    const subagent = {
      id: "subagent-1",
      name: "ResearchAgent",
      lastActivity: "2026-07-31T12:00:00.000Z",
    };
    const mainSession = { ...BASE_SESSION, activeSubagents: [subagent] };
    const subagentSession = {
      ...BASE_SESSION,
      id: subagent.id,
      name: subagent.name,
      status: "running" as const,
    };
    const props = composerDashboardProps(mainSession);
    props.sessions = [mainSession, subagentSession];

    let output = renderControlledDashboard(props);
    const openSubagent = findElements(
      output,
      (element) => element.props["aria-label"] === "Open ResearchAgent session",
    )[0];
    (openSubagent?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const viewer = findElements(output, (element) => element.type === SubagentSessionViewer)[0];
    expect(viewer?.props.open).toBe(true);
    const viewedWorkingRows = findElements(
      viewer?.props.children as ReactNode,
      (element) => element.type === MessageScrollerItem && element.props.messageId === "working:subagent-1",
    );
    expect(viewedWorkingRows).toHaveLength(1);
    const viewedIndicators = findElements(
      viewer?.props.children as ReactNode,
      (element) => element.type === WorkingIndicator,
    );
    expect(viewedIndicators).toHaveLength(1);
    expect(viewedIndicators[0]?.props.status).toBe("running");
    expect(
      renderTranscriptNodes(viewedIndicators[0]).filter(
        (node) => node.className === "ui-badge working-indicator",
      ),
    ).toEqual([expect.objectContaining({ text: "Working" })]);
  });

  it("displays informative status for running tools and streaming assistant messages in main transcript", () => {
    const bashMessage = {
      id: "msg-bash",
      role: "tool" as const,
      toolName: "bash",
      toolTitle: "Bash: pnpm test",
      text: "",
      timestamp: "2026-08-17T12:00:00.000Z",
      streaming: true,
      presentation: "text" as const,
      lifecycle: { state: "running" as const },
    };
    const runningBashOutput = renderControlledDashboard(
      composerDashboardProps({
        ...BASE_SESSION,
        status: "running",
        messages: [bashMessage],
      }),
    );
    const bashTranscript = findElements(
      runningBashOutput,
      (element) => element.props.className === "transcript",
    )[0];
    const bashIndicator = findElements(bashTranscript, (element) => element.type === WorkingIndicator)[0];
    expect(
      renderTranscriptNodes(bashIndicator).filter((node) => node.className === "ui-badge working-indicator"),
    ).toEqual([expect.objectContaining({ text: "Bash: pnpm test" })]);

    const thinkingMessage = {
      id: "msg-thinking",
      role: "assistant" as const,
      text: "Investigating the problem...",
      timestamp: "2026-08-17T12:00:00.000Z",
      streaming: true,
      presentation: "text" as const,
    };
    const runningThinkingOutput = renderControlledDashboard(
      composerDashboardProps({
        ...BASE_SESSION,
        status: "running",
        messages: [thinkingMessage],
      }),
    );
    const thinkingTranscript = findElements(
      runningThinkingOutput,
      (element) => element.props.className === "transcript",
    )[0];
    const thinkingIndicator = findElements(
      thinkingTranscript,
      (element) => element.type === WorkingIndicator,
    )[0];
    expect(
      renderTranscriptNodes(thinkingIndicator).filter(
        (node) => node.className === "ui-badge working-indicator",
      ),
    ).toEqual([expect.objectContaining({ text: "Thinking..." })]);
  });

  it("displays informative status for running tools in viewed subagent transcript", () => {
    const editMessage = {
      id: "msg-edit",
      role: "tool" as const,
      toolName: "edit",
      toolTitle: "Edit: 🟦 src/app.ts ⟦+1⟧",
      text: "",
      timestamp: "2026-08-17T12:00:00.000Z",
      streaming: true,
      presentation: "text" as const,
      lifecycle: { state: "running" as const },
    };
    const subagent = {
      id: "subagent-1",
      name: "ResearchAgent",
      lastActivity: "2026-07-31T12:00:00.000Z",
    };
    const mainSession = { ...BASE_SESSION, activeSubagents: [subagent] };
    const subagentSession = {
      ...BASE_SESSION,
      id: subagent.id,
      name: subagent.name,
      status: "running" as const,
      messages: [editMessage],
    };
    const props = composerDashboardProps(mainSession);
    props.sessions = [mainSession, subagentSession];

    let output = renderControlledDashboard(props);
    const openSubagent = findElements(
      output,
      (element) => element.props["aria-label"] === "Open ResearchAgent session",
    )[0];
    (openSubagent?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const viewer = findElements(output, (element) => element.type === SubagentSessionViewer)[0];
    const viewedIndicators = findElements(
      viewer?.props.children as ReactNode,
      (element) => element.type === WorkingIndicator,
    );
    expect(viewedIndicators).toHaveLength(1);
    expect(
      renderTranscriptNodes(viewedIndicators[0]).filter(
        (node) => node.className === "ui-badge working-indicator",
      ),
    ).toEqual([expect.objectContaining({ text: "Edit: 🟦 src/app.ts ⟦+1⟧" })]);
  });

  it("formats working labels across various message states and fallbacks", () => {
    expect(formatWorkingLabel(undefined)).toBe("Working");
    expect(formatWorkingLabel(null)).toBe("Working");
    expect(
      formatWorkingLabel({
        id: "1",
        role: "tool",
        toolName: "bash",
        toolTitle: "Bash: git status",
        text: "",
        timestamp: "2026-08-17T12:00:00.000Z",
        streaming: true,
        presentation: "text",
      }),
    ).toBe("Bash: git status");
    expect(
      formatWorkingLabel({
        id: "2",
        role: "tool",
        toolName: "read",
        text: "",
        timestamp: "2026-08-17T12:00:00.000Z",
        streaming: true,
        presentation: "text",
      }),
    ).toBe("Read");
    expect(
      formatWorkingLabel({
        id: "3",
        role: "tool",
        text: "",
        timestamp: "2026-08-17T12:00:00.000Z",
        streaming: true,
        presentation: "text",
      }),
    ).toBe("Tool");
    expect(
      formatWorkingLabel({
        id: "4",
        role: "assistant",
        text: "Thinking",
        timestamp: "2026-08-17T12:00:00.000Z",
        streaming: true,
        presentation: "text",
      }),
    ).toBe("Thinking...");
    expect(
      formatWorkingLabel({
        id: "5",
        role: "tool",
        toolName: "bash",
        toolTitle: "Bash: pnpm test",
        text: "completed",
        timestamp: "2026-08-17T12:00:00.000Z",
        streaming: false,
        presentation: "text",
        lifecycle: { state: "success" },
      }),
    ).toBe("Working");
    expect(
      formatWorkingLabel({
        id: "6",
        role: "user",
        text: "hello",
        timestamp: "2026-08-17T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      }),
    ).toBe("Working");
  });
});

describe("message scroller controls", () => {
  it("uses immediate jump controls so reduced-motion preferences are respected", () => {
    expect(MessageScrollerButton({}).props.behavior).toBe("auto");
  });

  it("registers an immediate scroll-to-end handler for submitted messages", () => {
    const onScrollToEnd = vi.fn();

    MessageScrollerScrollController({ onScrollToEnd });

    const handler = onScrollToEnd.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(handler).toBeTypeOf("function");
    handler?.();
    expect(messageScrollerHarness.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
  });
});

function getTranscriptViewport(output: ReactNode) {
  const el = findElements(output, (node) => node.type === MessageScrollerViewport)[0];
  expect(el).toBeDefined();
  return el as ReactElement<{
    preserveScrollOnPrepend?: boolean;
    onScroll?: (event: {
      currentTarget: { scrollTop: number; dataset: Record<string, string | undefined> };
    }) => void;
  }>;
}

function getButton(output: ReactNode, label: string) {
  return findElements(output, (el) => el.type === Button).find((b) => textContent(b) === label) as
    | ReactElement<{ onClick?: () => void }>
    | undefined;
}

describe("transcript pagination and recovery", () => {
  it("keeps messages anchored and hides the empty state during loading", () => {
    const session: Session = {
      ...BASE_SESSION,
      messages: [
        {
          id: "m-1",
          role: "user",
          text: "Kept message",
          timestamp: "2026-08-17T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    };
    for (const [initialLoading, olderLoading, label] of [
      [true, false, "Loading recent messages…"],
      [false, true, "Loading earlier messages…"],
    ] as const) {
      const output = renderControlledDashboard({
        ...composerDashboardProps(session),
        transcriptHistory: {
          sessionId: session.id,
          initialLoading,
          olderLoading,
          status: "available",
          error: null,
        },
      });
      expect(textContent(output)).toContain(label);
      const rows = findElements(output, (node) => node.type === MessageScrollerItem);
      expect(rows.some((row) => row.props.messageId === "m-1")).toBe(true);
      expect(rows.findIndex((row) => row.props.messageId === `transcript-status:${session.id}`)).toBeLessThan(
        rows.findIndex((row) => row.props.messageId === "m-1"),
      );
    }
    const emptyOutput = renderControlledDashboard({
      ...composerDashboardProps({ ...BASE_SESSION, source: "history" }),
      transcriptHistory: {
        sessionId: BASE_SESSION.id,
        initialLoading: true,
        olderLoading: false,
        status: null,
        error: null,
      },
    });
    expect(textContent(emptyOutput)).not.toContain("No text messages in this session");
  });

  it("configures preserveScrollOnPrepend and gates near-top scroll requests", () => {
    const onLoadOlderTranscript = vi.fn().mockResolvedValue(undefined);
    const sessionWithMessages: Session = {
      ...BASE_SESSION,
      messages: [
        {
          id: "m-1",
          role: "user",
          text: "Kept message",
          timestamp: "2026-08-17T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    };
    const base = {
      ...composerDashboardProps(sessionWithMessages),
      onLoadOlderTranscript,
      transcriptHistory: {
        sessionId: sessionWithMessages.id,
        initialLoading: false,
        olderLoading: false,
        status: "available" as const,
        error: null,
      },
    };

    const initialOutput = renderControlledDashboard(base);
    const rows = findElements(initialOutput, (node) => node.type === MessageScrollerItem);
    const statusIndex = rows.findIndex(
      (row) => row.props.messageId === `transcript-status:${sessionWithMessages.id}`,
    );
    const messageIndex = rows.findIndex((row) => row.props.messageId === "m-1");
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeGreaterThan(statusIndex);

    const viewport = getTranscriptViewport(initialOutput);
    expect(viewport.props.preserveScrollOnPrepend).toBe(true);

    // Persistent scroll viewport DOM target for session 1
    const s1Target = {
      scrollTop: 50,
      dataset: {} as Record<string, string | undefined>,
    };

    // First outside-to-inside threshold crossing requests once
    viewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);

    // Same-zone scroll events on the persistent target do not request again
    s1Target.scrollTop = 40;
    viewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);

    // After an olderLoading true -> false rerender, same-zone events on the persistent target do not request again
    const loadingOutput = renderControlledDashboard(
      {
        ...base,
        transcriptHistory: { ...base.transcriptHistory, olderLoading: true },
      },
      { preserveState: true },
    );
    const loadingViewport = getTranscriptViewport(loadingOutput);
    s1Target.scrollTop = 50;
    loadingViewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);

    const settledOutput = renderControlledDashboard(
      {
        ...base,
        transcriptHistory: { ...base.transcriptHistory, olderLoading: false },
      },
      { preserveState: true },
    );
    const settledViewport = getTranscriptViewport(settledOutput);
    s1Target.scrollTop = 60;
    settledViewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);

    // Crossing outside then inside requests exactly once more
    s1Target.scrollTop = 150;
    settledViewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);

    s1Target.scrollTop = 50;
    settledViewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(2);

    s1Target.scrollTop = 45;
    settledViewport.props.onScroll?.({ currentTarget: s1Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(2);

    // Complete/error/loading states still gate requests
    for (const [override] of [
      [{ status: "complete" as const }],
      [{ status: "unavailable" as const }],
      [{ error: "err" }],
      [{ olderLoading: true }],
      [{ initialLoading: true }],
    ] as const) {
      onLoadOlderTranscript.mockClear();
      const gatedTarget = {
        scrollTop: 150,
        dataset: {} as Record<string, string | undefined>,
      };
      const vp = getTranscriptViewport(
        renderControlledDashboard({ ...base, transcriptHistory: { ...base.transcriptHistory, ...override } }),
      );
      vp.props.onScroll?.({ currentTarget: gatedTarget });
      gatedTarget.scrollTop = 50;
      vp.props.onScroll?.({ currentTarget: gatedTarget });
      expect(onLoadOlderTranscript).not.toHaveBeenCalled();
    }

    // Selected-session change resets/scopes transition memory with a fresh keyed viewport target
    const session2: Session = {
      ...BASE_SESSION,
      id: "session-2",
    };

    // Switch to session 2 with a fresh viewport element
    const s2Target = {
      scrollTop: 50,
      dataset: {} as Record<string, string | undefined>,
    };
    const s2Output = renderControlledDashboard(
      {
        ...composerDashboardProps(session2),
        sessions: [sessionWithMessages, session2],
        selectedSessionId: session2.id,
        onLoadOlderTranscript,
        transcriptHistory: {
          sessionId: session2.id,
          initialLoading: false,
          olderLoading: false,
          status: "available" as const,
          error: null,
        },
      },
      { preserveState: true },
    );
    const s2Vp = getTranscriptViewport(s2Output);
    onLoadOlderTranscript.mockClear();
    s2Vp.props.onScroll?.({ currentTarget: s2Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);
    s2Target.scrollTop = 40;
    s2Vp.props.onScroll?.({ currentTarget: s2Target });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);

    // Switch back to session 1; keyed viewport remounts with fresh dataset, so crossing inside requests again
    const s1RemountTarget = {
      scrollTop: 50,
      dataset: {} as Record<string, string | undefined>,
    };
    const s1BackOutput = renderControlledDashboard(
      {
        ...base,
        sessions: [sessionWithMessages, session2],
        selectedSessionId: sessionWithMessages.id,
      },
      { preserveState: true },
    );
    const s1BackVp = getTranscriptViewport(s1BackOutput);
    onLoadOlderTranscript.mockClear();
    s1BackVp.props.onScroll?.({ currentTarget: s1RemountTarget });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);
    s1RemountTarget.scrollTop = 40;
    s1BackVp.props.onScroll?.({ currentTarget: s1RemountTarget });
    expect(onLoadOlderTranscript).toHaveBeenCalledTimes(1);
  });

  it("renders status labels and handles corresponding button actions", async () => {
    const onLoadOlderTranscript = vi.fn().mockResolvedValue(undefined);
    const onRetryTranscript = vi.fn().mockRejectedValue(new Error("offline"));
    const onReloadTranscript = vi.fn().mockResolvedValue(undefined);
    const base = {
      ...composerDashboardProps(),
      onLoadOlderTranscript,
      onRetryTranscript,
      onReloadTranscript,
    };

    const cases = [
      {
        history: { error: "Host disconnected" },
        text: "Transcript history could not be loaded.",
        actions: [
          ["Retry", onRetryTranscript],
          ["Reload history", onReloadTranscript],
        ],
      },
      {
        history: { status: "invalidated" as const },
        text: "Transcript invalidated on host",
        actions: [["Reload history", onReloadTranscript]],
      },
      {
        history: { status: "complete" as const },
        text: "Start of session",
        actions: [["Reload history", onReloadTranscript]],
      },
      {
        history: { status: "available" as const },
        text: "Earlier messages available",
        actions: [
          ["Load earlier", onLoadOlderTranscript],
          ["Reload history", onReloadTranscript],
        ],
      },
      { history: { status: "unavailable" as const }, text: "Earlier messages unavailable", actions: [] },
    ] as const;

    for (const { history, text, actions } of cases) {
      const output = renderControlledDashboard({
        ...base,
        transcriptHistory: {
          sessionId: BASE_SESSION.id,
          initialLoading: false,
          olderLoading: false,
          status: null,
          error: null,
          ...history,
        },
      });
      expect(textContent(output)).toContain(text);
      for (const [btnLabel, fn] of actions) {
        fn.mockClear();
        const btn = getButton(output, btnLabel);
        expect(btn).toBeDefined();
        btn?.props.onClick?.();
        expect(fn).toHaveBeenCalledOnce();
      }
    }
    await Promise.resolve();
  });

  it("triggers onLoadTranscript exactly once per session selection including live sessions", () => {
    const onLoadTranscript = vi.fn().mockResolvedValue(undefined);
    const liveSession: Session = {
      ...BASE_SESSION,
      id: "live-session-1",
      status: "running",
      source: "rpc",
      connected: true,
      messages: [
        {
          id: "m-live",
          role: "assistant",
          text: "Working",
          timestamp: "2026-08-17T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    };

    renderControlledDashboard({
      ...composerDashboardProps(liveSession),
      sessions: [liveSession],
      selectedSessionId: liveSession.id,
      onLoadTranscript,
    });

    expect(onLoadTranscript).toHaveBeenCalledOnce();
    expect(onLoadTranscript).toHaveBeenCalledWith("live-session-1");
  });
});
