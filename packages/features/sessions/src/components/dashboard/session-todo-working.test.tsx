import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  getMessageScrollerHarness,
  renderControlledDashboard,
  renderTranscriptNodes,
  SELECT_ASK,
} from "./dashboard-test-support.js";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatWorkingLabel, MessageScrollerScrollController, WorkingIndicator } from "../dashboard.js";
import { SubagentSessionViewer } from "../subagent-session-viewer.js";
import { MessageScrollerButton, MessageScrollerItem } from "../ui/message-scroller.js";
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
