import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import type { Session } from "@omp-remote/protocol";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatUsd, getSessionCostRows } from "../session-cost.js";
import { SessionCostMetadata, SessionCostViewer } from "../session-cost-viewer.js";

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [-0, "$0.00"],
    [2.5, "$2.50"],
    [0.0042, "$0.0042"],
    [0.00001, "$0.00001"],
    [-0.00001, "-$0.00001"],
    [0.00999, "$0.01"],
    [1.005, "$1.01"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});

describe("session cost hierarchy", () => {
  const summary: NonNullable<Session["costSummary"]> = {
    totalUsd: 2.1,
    partial: true,
    agents: [
      { sessionId: "child", name: "Child", parentSessionId: "root", totalUsd: 0.004, available: true },
      {
        sessionId: "grandchild",
        name: "Grandchild",
        parentSessionId: "child",
        totalUsd: 0.2,
        available: false,
      },
      { sessionId: "root", name: "Root", parentSessionId: null, totalUsd: 1.9, available: true },
    ],
  };

  it("puts the selected main agent first and indents descendants by their chain", () => {
    expect(getSessionCostRows(summary, "root").map(({ agent, depth }) => [agent.name, depth])).toEqual([
      ["Root", 0],
      ["Child", 1],
      ["Grandchild", 2],
    ]);
  });
});

describe("dashboard session cost", () => {
  const costSummary: NonNullable<Session["costSummary"]> = {
    totalUsd: 1.25,
    partial: true,
    agents: [
      { sessionId: "session-1", name: "Bootstrap", parentSessionId: null, totalUsd: 1.2, available: true },
      { sessionId: "child", name: "Child", parentSessionId: "session-1", totalUsd: 0.05, available: false },
    ],
  };

  it("opens from metadata, rerenders live updates, and resets on selection change", () => {
    const second = { ...BASE_SESSION, id: "session-2", name: "Second" };
    let props = {
      ...composerDashboardProps({ ...BASE_SESSION, costSummary }),
      sessions: [{ ...BASE_SESSION, costSummary }, second],
    };
    let output = renderControlledDashboard(props);
    const metadata = findElements(output, (element) => element.type === SessionCostMetadata)[0] as
      | ReactElement<{ summary: Session["costSummary"]; onOpen(): void }>
      | undefined;
    const metadataButton = metadata ? SessionCostMetadata(metadata.props) : null;
    expect(metadataButton?.props.children).toBe("$1.25 · Partial");
    expect(metadataButton?.props["aria-label"]).toContain("Partial");
    metadata?.props.onOpen();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const viewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ open: boolean; session: Session | null }>
      | undefined;
    expect(viewer?.props.open).toBe(true);
    expect(viewer?.props.session?.costSummary?.totalUsd).toBe(1.25);

    props = {
      ...props,
      sessions: [{ ...BASE_SESSION, costSummary: { ...costSummary, totalUsd: 2.5 } }, second],
    };
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const updatedViewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ open: boolean; session: Session | null }>
      | undefined;
    expect(updatedViewer?.props.session?.costSummary?.totalUsd).toBe(2.5);

    props = { ...props, selectedSessionId: second.id };
    output = renderControlledDashboard(props, { preserveState: true });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const resetViewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ open: boolean; session: Session | null }>
      | undefined;
    expect(resetViewer?.props.open).toBe(false);
  });

  it("renders history sessions through the same viewer with unavailable rows", () => {
    const history = {
      ...BASE_SESSION,
      source: "history" as const,
      status: "history" as const,
      connected: false,
      costSummary: undefined,
    };
    const output = renderControlledDashboard(composerDashboardProps(history));
    const viewer = findElements(output, (element) => element.type === SessionCostViewer)[0] as
      | ReactElement<{ session: Session | null }>
      | undefined;
    expect(viewer?.props.session?.source).toBe("history");
    const rendered = SessionCostViewer({
      session: history,
      mobile: false,
      open: true,
      onOpenChange: vi.fn(),
    });
    expect(textContent(rendered.props.children)).toContain("Session cost");
  });
});
