import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  getMessageScrollerHarness,
  renderControlledDashboard,
  renderTranscriptNodes,
} from "./dashboard-test-support.js";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageScrollerScrollController, WorkingIndicator } from "../dashboard.js";
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
