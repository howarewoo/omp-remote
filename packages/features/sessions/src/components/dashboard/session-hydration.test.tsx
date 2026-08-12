// biome-ignore-all assist/source/organizeImports: The test support must install the React hook mock first.
import {
  BASE_SESSION,
  composerDashboardProps,
  findElements,
  getReactHarness,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import type { Session } from "@omp-remote/protocol";
import type { ControlledDashboardProps } from "./dashboard-test-support.js";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardProps } from "../dashboard.js";
import { SubagentSessionViewer } from "../subagent-session-viewer.js";
import { Button } from "../ui/button.js";

const reactHarness = getReactHarness();

describe("catalog-only subagent hydration", () => {
  const childA = {
    id: "child-a",
    name: "Saved child A",
    lastActivity: "2026-08-01T12:00:00.000Z",
  };
  const childB = {
    id: "child-b",
    name: "Saved child B",
    lastActivity: "2026-08-01T12:01:00.000Z",
  };
  function deferred() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, reject, resolve };
  }

  function hydrationProps(
    onLoadSession: DashboardProps["onLoadSession"] = vi.fn().mockResolvedValue(undefined),
  ): ControlledDashboardProps {
    const root = {
      ...BASE_SESSION,
      id: "root",
      name: "Root",
      parentSessionId: null,
      activeSubagents: [childA, childB],
    };
    return {
      ...composerDashboardProps(root),
      sessions: [root],
      sessionsReady: true,
      onLoadSession,
    };
  }

  function openSubagent(output: ReactNode, name: string): void {
    const trigger = findElements(
      output,
      (element) => element.props["aria-label"] === `Open ${name} session`,
    )[0];
    (trigger?.props.onClick as (() => void) | undefined)?.();
  }

  function findSubagentViewer(output: ReactNode) {
    return findElements(output, (element) => element.type === SubagentSessionViewer)[0];
  }

  it("requests one missing advertised child only after both sources are ready", () => {
    reactHarness.lifecycleEffects = true;
    const onLoadSession = vi.fn().mockResolvedValue(undefined);
    const props = hydrationProps(onLoadSession);
    props.sessionsReady = false;
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    output = renderControlledDashboard(props, { preserveState: true });
    expect(onLoadSession).not.toHaveBeenCalled();

    props.sessionsReady = true;
    output = renderControlledDashboard(props, { preserveState: true });
    renderControlledDashboard(props, { preserveState: true });

    expect(onLoadSession).toHaveBeenCalledTimes(1);
    expect(onLoadSession).toHaveBeenCalledWith(childA.id);
    expect(findSubagentViewer(output)?.props.detailsState).toBe("loading");
  });

  it("renders saved output and keeps the hydrated child out of global navigation", async () => {
    reactHarness.lifecycleEffects = true;
    const onLoadSession = vi.fn().mockResolvedValue(undefined);
    const props = hydrationProps(onLoadSession);
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    renderControlledDashboard(props, { preserveState: true });
    await Promise.resolve();
    const savedChild: Session = {
      ...BASE_SESSION,
      id: childA.id,
      source: "history",
      name: childA.name,
      status: "history",
      connected: false,
      parentSessionId: "root",
      messages: [
        {
          id: "saved-output",
          role: "assistant",
          text: "Persisted subagent result",
          timestamp: "2026-08-01T12:00:01.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    };
    props.sessions = [...props.sessions, savedChild];
    output = renderControlledDashboard(props, { preserveState: true });

    const viewer = findSubagentViewer(output);
    expect(viewer?.props.detailsState).toBe("saved");
    expect(viewer?.props.session).toMatchObject({
      id: childA.id,
      source: "history",
      messages: [{ id: "saved-output", text: "Persisted subagent result" }],
    });
    const renderedViewer = SubagentSessionViewer(
      viewer?.props as unknown as Parameters<typeof SubagentSessionViewer>[0],
    );
    expect(textContent(renderedViewer)).toContain("Saved session");
    const globalSessionList = findElements(
      output,
      (element) => element.props.className === "session-list",
    )[0];
    expect(textContent(globalSessionList)).not.toContain(childA.name);
  });

  it("labels an initialization-only history child as saved with no saved output", async () => {
    reactHarness.lifecycleEffects = true;
    const props = hydrationProps();
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    renderControlledDashboard(props, { preserveState: true });
    await Promise.resolve();
    props.sessions = [
      ...props.sessions,
      {
        ...BASE_SESSION,
        id: childA.id,
        source: "history",
        name: childA.name,
        status: "history",
        connected: false,
        parentSessionId: "root",
        messages: [],
      },
    ];
    output = renderControlledDashboard(props, { preserveState: true });

    const viewer = findSubagentViewer(output);
    expect(viewer?.props.detailsState).toBe("empty");
    expect(textContent(viewer?.props.children as ReactNode)).toContain(
      "No saved output is available for this session.",
    );
    expect(
      textContent(
        SubagentSessionViewer(viewer?.props as unknown as Parameters<typeof SubagentSessionViewer>[0]),
      ),
    ).toContain("Saved session");
  });

  it("terminates failures with an explicit keyboard retry and retries only on activation", async () => {
    reactHarness.lifecycleEffects = true;
    const onLoadSession = vi.fn().mockRejectedValue(new Error("not found"));
    const props = hydrationProps(onLoadSession);
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    renderControlledDashboard(props, { preserveState: true });
    await Promise.resolve();
    output = renderControlledDashboard(props, { preserveState: true });

    let viewer = findSubagentViewer(output);
    expect(viewer?.props.detailsState).toBe("error");
    expect(textContent(viewer?.props.children as ReactNode)).toContain("Session unavailable");
    const renderedViewer = SubagentSessionViewer(
      viewer?.props as unknown as Parameters<typeof SubagentSessionViewer>[0],
    );
    const retry = findElements(
      renderedViewer,
      (element) => element.type === Button && textContent(element) === "Retry",
    )[0];
    expect(retry?.props.type).toBe("button");
    expect(onLoadSession).toHaveBeenCalledOnce();

    (retry?.props.onClick as (() => void) | undefined)?.();
    expect(onLoadSession).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    viewer = findSubagentViewer(output);
    expect(viewer?.props.detailsState).toBe("error");
  });

  it("opens an already-live child immediately without a details request", () => {
    reactHarness.lifecycleEffects = true;
    const onLoadSession = vi.fn().mockResolvedValue(undefined);
    const props = hydrationProps(onLoadSession);
    props.sessions = [
      ...props.sessions,
      {
        ...BASE_SESSION,
        id: childA.id,
        name: childA.name,
        source: "extension",
        parentSessionId: "root",
        status: "running",
      },
    ];
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    output = renderControlledDashboard(props, { preserveState: true });

    expect(onLoadSession).not.toHaveBeenCalled();
    expect(findSubagentViewer(output)?.props.detailsState).toBe("live");
  });

  it("invalidates stale child completions when switching children", async () => {
    reactHarness.lifecycleEffects = true;
    const first = deferred();
    const second = deferred();
    const onLoadSession = vi.fn((sessionId: string) =>
      sessionId === childA.id ? first.promise : second.promise,
    );
    const props = hydrationProps(onLoadSession);
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    output = renderControlledDashboard(props, { preserveState: true });
    openSubagent(output, childB.name);
    output = renderControlledDashboard(props, { preserveState: true });
    expect(onLoadSession.mock.calls).toEqual([[childA.id], [childB.id]]);

    first.resolve();
    second.reject(new Error("child B unavailable"));
    await Promise.allSettled([first.promise, second.promise]);
    await Promise.resolve();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const viewer = findSubagentViewer(output);
    expect(viewer?.props.subagent).toMatchObject({ id: childB.id });
    expect(viewer?.props.detailsState).toBe("error");
  });

  it("invalidates a pending completion when the drawer closes", async () => {
    reactHarness.lifecycleEffects = true;
    const pending = deferred();
    const onLoadSession = vi.fn(() => pending.promise);
    const props = hydrationProps(onLoadSession);
    let output = renderControlledDashboard(props);

    openSubagent(output, childA.name);
    output = renderControlledDashboard(props, { preserveState: true });
    const viewer = findSubagentViewer(output);
    (viewer?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(false);
    output = renderControlledDashboard(props, { preserveState: true });

    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findSubagentViewer(output)?.props.open).toBe(false);
    expect(onLoadSession).toHaveBeenCalledOnce();
  });
});
