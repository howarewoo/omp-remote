import {
  BASE_SESSION,
  type ControlledDashboardProps,
  DASHBOARD_DEFAULTS,
  SELECT_ASK,
  composerDashboardProps,
  findElements,
  findHostText,
  getReactHarness,
  renderControlledDashboard,
  textContent,
} from "./dashboard-test-support.js";
import type { Session } from "@omp-remote/protocol";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AskToolCall, type DashboardProps } from "../dashboard.js";
import { Drawer } from "../ui/drawer.js";
import {
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "../ui/message-scroller.js";
const reactHarness = getReactHarness();

describe("dashboard ask stream", () => {
  it("marks a session with a pending question as waiting", () => {
    const output = renderControlledDashboard({
      ...composerDashboardProps(),
      askRequests: [SELECT_ASK],
    });
    const sidebarSession = findElements(
      output,
      (element) => element.props.className === "session-item session-item-selected",
    )[0];
    const statusDot = findElements(
      sidebarSession,
      (element) => element.props.className === "session-state-dot session-state-waiting",
    )[0];
    const statusBadge = findElements(
      output,
      (element) => element.props.className === "status-badge status-waiting",
    )[0];

    expect(sidebarSession?.props["aria-label"]).toBe("Bootstrap, Waiting");
    expect(statusDot).toBeDefined();
    expect(textContent(statusBadge)).toBe("Waiting");
  });

  it("keeps the selected session ask as a stable row inside transcript content", async () => {
    const message = {
      id: "message-1",
      role: "user" as const,
      text: "Transcript input",
      presentation: "text" as const,
      timestamp: "2026-07-31T12:00:00.000Z",
      streaming: false,
    };
    const onRespondToAsk = vi.fn().mockResolvedValue(undefined);
    const onAskActivity = vi.fn().mockResolvedValue(undefined);
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [{ ...BASE_SESSION, messages: [message] }],
      askRequests: [SELECT_ASK],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "unsupported",
      selectedSessionId: "session-1",
      onRespondToAsk,
      onAskActivity,
      onSelectedSessionChange: vi.fn(),
    });
    const viewport = findElements(output, (element) => element.type === MessageScrollerViewport)[0];
    const content = findElements(viewport, (element) => element.type === MessageScrollerContent)[0];
    const rows = findElements(content, (element) => element.type === MessageScrollerItem);
    const messageRow = rows.find((row) => row.props.messageId === "message-1");
    const askRow = rows.find((row) => row.props.messageId === "ask:session-1:ask-select");
    const ask = findElements(askRow, (element) => element.type === AskToolCall)[0];

    expect(viewport?.props.className).toBe("transcript");
    expect(viewport?.props["aria-label"]).toBe("Session transcript");
    expect(content?.props.role).toBe("log");
    expect(content?.props["aria-live"]).toBe("polite");
    expect(messageRow?.props.scrollAnchor).toBe(true);
    expect(askRow).toBeDefined();
    await (ask?.props.onRespond as ((response: { value: string }) => Promise<void>) | undefined)?.({
      value: "Preview",
    });
    expect(onRespondToAsk).toHaveBeenCalledWith("session-1", "ask-select", { value: "Preview" });
    (ask?.props.onActivity as (() => void) | undefined)?.();
    expect(onAskActivity).toHaveBeenCalledWith("session-1", "ask-select");
    expect(findElements(output, (element) => element.props.open === true)).toHaveLength(0);
  });

  it("shows an ask in an empty selected session without rendering the ready state", () => {
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      askRequests: [SELECT_ASK],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "unsupported",
      selectedSessionId: "session-1",
      onSelectedSessionChange: vi.fn(),
    });

    expect(textContent(output)).not.toContain("Ready for an instruction");
    expect(findElements(output, (element) => element.type === AskToolCall)).toHaveLength(1);
  });

  it("does not render another session's ask in the selected transcript", () => {
    const otherAsk = { ...SELECT_ASK, sessionId: "session-2", title: "Other session question" };
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2" }],
      askRequests: [otherAsk],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "unsupported",
      selectedSessionId: "session-1",
      onSelectedSessionChange: vi.fn(),
    });

    expect(findElements(output, (element) => element.type === AskToolCall)).toHaveLength(0);
    expect(textContent(output)).not.toContain("Other session question");
    expect(textContent(output)).toContain("Ready for an instruction");
  });
});

describe("controlled dashboard selection", () => {
  it("uses a requested session instead of the default first session", () => {
    const sessions = [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Requested session" }];

    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions,
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "enabled",
      selectedSessionId: "session-2",
      onSelectedSessionChange: vi.fn(),
    });

    expect(findHostText(output, "h1")).toBe("Requested session");
  });

  it("preserves a requested session while the list is empty and selects it when sessions arrive", () => {
    const onSelectedSessionChange = vi.fn();
    const baseProps = {
      ...DASHBOARD_DEFAULTS,
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected" as const,
      error: null,
      notificationState: "enabled" as const,
      selectedSessionId: "session-2",
      onSelectedSessionChange,
    };

    renderControlledDashboard({ ...baseProps, sessions: [] });
    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const output = renderControlledDashboard({
      ...baseProps,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Requested session" }],
    });
    expect(findHostText(output, "h1")).toBe("Requested session");
  });

  it("does not replace a requested ID from a nonempty partial session update", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected" as const,
      error: null,
      notificationState: "enabled" as const,
      selectedSessionId: "session-2",
      onSelectedSessionChange,
    };

    renderControlledDashboard({ ...props, sessions: [BASE_SESSION], sessionsReady: false });
    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const output = renderControlledDashboard({
      ...props,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Requested session" }],
      sessionsReady: true,
    });
    expect(findHostText(output, "h1")).toBe("Requested session");
    expect(onSelectedSessionChange).not.toHaveBeenCalled();
  });

  it("falls back deterministically and reports the first session when the requested ID is absent", () => {
    const onSelectedSessionChange = vi.fn();

    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Second session" }],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "enabled",
      selectedSessionId: "missing-session",
      onSelectedSessionChange,
    });

    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(onSelectedSessionChange).toHaveBeenCalledWith("session-1");
  });

  it("loads cost for the viewed session as selection changes", () => {
    const onLoadCost = vi.fn().mockResolvedValue(undefined);
    const secondSession = { ...BASE_SESSION, id: "session-2", name: "Second session" };
    const props = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadCost,
    };

    renderControlledDashboard(props);
    renderControlledDashboard({ ...props, selectedSessionId: secondSession.id }, { preserveState: true });
    expect(onLoadCost.mock.calls).toEqual([[BASE_SESSION.id], [secondSession.id]]);
  });
});

describe("dashboard launch selection", () => {
  const baseProps = {
    ...DASHBOARD_DEFAULTS,
    sessions: [BASE_SESSION],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected" as const,
    error: null,
    notificationState: "enabled" as const,
    selectedSessionId: BASE_SESSION.id,
  };

  it("selects the exact session returned by a successful new launch and resets the modal", async () => {
    const onLaunch = vi.fn().mockResolvedValue("new-session-id");
    const onSelectedSessionChange = vi.fn();
    const props = { ...baseProps, onLaunch, onSelectedSessionChange };
    let output = renderControlledDashboard(props);
    const newSessionButton = findElements(output, (element) => textContent(element) === "New session")[0];
    (newSessionButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const cwdInput = findElements(output, (element) => element.props.id === "launch-cwd")[0];
    (cwdInput?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: " /work/new-project " },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const form = findElements(output, (element) => element.props.className === "launch-form")[0];
    const reset = vi.fn();
    vi.stubGlobal(
      "FormData",
      class {
        get() {
          return " resume-session ";
        }
      },
    );
    try {
      await (
        form?.props.onSubmit as
          | ((event: { preventDefault(): void; currentTarget: { reset(): void } }) => Promise<void>)
          | undefined
      )?.({ preventDefault: vi.fn(), currentTarget: { reset } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onLaunch).toHaveBeenCalledWith("/work/new-project", "resume-session");
    expect(onSelectedSessionChange).toHaveBeenCalledOnce();
    expect(onSelectedSessionChange).toHaveBeenCalledWith("new-session-id");
    expect(reset).toHaveBeenCalledOnce();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(
      findElements(output, (element) => element.props.title === "Start an OMP session")[0]?.props.open,
    ).toBe(false);
  });

  it("selects the exact session returned by a successful resume", async () => {
    const historySession = {
      ...BASE_SESSION,
      source: "history" as const,
      status: "history" as const,
      connected: false,
    };
    const onLaunch = vi.fn().mockResolvedValue("resumed-session-id");
    const onSelectedSessionChange = vi.fn();
    const output = renderControlledDashboard({
      ...baseProps,
      sessions: [historySession],
      selectedSessionId: historySession.id,
      onLaunch,
      onSelectedSessionChange,
    });
    const resumeButton = findElements(output, (element) => textContent(element) === "Resume session")[0];
    (resumeButton?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onLaunch).toHaveBeenCalledWith(historySession.cwd, historySession.sessionPath);
    expect(onSelectedSessionChange).toHaveBeenCalledOnce();
    expect(onSelectedSessionChange).toHaveBeenCalledWith("resumed-session-id");
  });

  it("does not select a session when resume fails", async () => {
    const historySession = {
      ...BASE_SESSION,
      source: "history" as const,
      status: "history" as const,
      connected: false,
    };
    const onSelectedSessionChange = vi.fn();
    const output = renderControlledDashboard({
      ...baseProps,
      sessions: [historySession],
      selectedSessionId: historySession.id,
      onLaunch: vi.fn().mockRejectedValue(new Error("resume failed")),
      onSelectedSessionChange,
    });
    const resumeButton = findElements(output, (element) => textContent(element) === "Resume session")[0];
    (resumeButton?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onSelectedSessionChange).not.toHaveBeenCalled();
  });

  it("does not select or reset the modal when a new launch fails", async () => {
    const onLaunch = vi.fn().mockRejectedValue(new Error("launch failed"));
    const onSelectedSessionChange = vi.fn();
    const props = { ...baseProps, onLaunch, onSelectedSessionChange };
    let output = renderControlledDashboard(props);
    const newSessionButton = findElements(output, (element) => textContent(element) === "New session")[0];
    (newSessionButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const cwdInput = findElements(output, (element) => element.props.id === "launch-cwd")[0];
    (cwdInput?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "/work/failing-project" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const form = findElements(output, (element) => element.props.className === "launch-form")[0];
    const reset = vi.fn();
    vi.stubGlobal(
      "FormData",
      class {
        get() {
          return "";
        }
      },
    );
    try {
      await (
        form?.props.onSubmit as
          | ((event: { preventDefault(): void; currentTarget: { reset(): void } }) => Promise<void>)
          | undefined
      )?.({ preventDefault: vi.fn(), currentTarget: { reset } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onSelectedSessionChange).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(textContent(output)).toContain("launch failed");
    expect(
      findElements(output, (element) => element.props.title === "Start an OMP session")[0]?.props.open,
    ).toBe(true);
  });
});

const CONFIGURABLE_SESSION: Session = {
  ...BASE_SESSION,
  capabilities: [...BASE_SESSION.capabilities, "model", "effort"],
  effort: "medium",
  availableModels: [
    {
      provider: "anthropic",
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      efforts: ["low", "medium", "high", "max"],
    },
    {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      efforts: ["low", "medium", "high", "xhigh"],
      roles: ["default"],
    },
  ],
};

function configurationProps(
  session: Session,
  callbacks: Partial<Pick<DashboardProps, "onSetModel" | "onSetEffort">> = {},
): ControlledDashboardProps {
  return {
    ...DASHBOARD_DEFAULTS,
    sessions: [session],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected",
    error: null,
    notificationState: "enabled",
    selectedSessionId: session.id,
    onSelectedSessionChange: vi.fn(),
    ...callbacks,
  };
}

function findConfigurationTrigger(output: ReactNode, kind: "model" | "effort") {
  const label = `Change ${kind}.`;
  return findElements(
    output,
    (element) =>
      typeof element.props["aria-label"] === "string" && element.props["aria-label"].startsWith(label),
  )[0];
}

function findConfigurationDrawer(output: ReactNode, title: "Model" | "Effort") {
  return findElements(
    output,
    (element) => element.type === Drawer && textContent(element.props.children as ReactNode).includes(title),
  )[0];
}

describe("session model and effort selectors", () => {
  it("renders separate tappable Model and Effort selector cells", () => {
    const output = renderControlledDashboard(configurationProps(CONFIGURABLE_SESSION));

    expect(findConfigurationTrigger(output, "model")?.props.disabled).not.toBe(true);
    expect(findConfigurationTrigger(output, "effort")?.props.disabled).not.toBe(true);
    expect(
      findElements(output, (element) => element.type === "dt").map((element) => textContent(element)),
    ).toEqual(["Branch", "Model", "Effort", "Context", "Changes", "Cost"]);
  });

  it("opens a populated model-only drawer", () => {
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const drawer = findConfigurationDrawer(output, "Model");
    expect(drawer?.props.open).toBe(true);
    expect(drawer?.props).toMatchObject({ showSwipeHandle: false, swipeDirection: "right" });
    expect(textContent(drawer?.props.children as ReactNode)).toContain("GPT-5.6");
    expect(textContent(drawer?.props.children as ReactNode)).toContain("Configured roles: default");
    expect(textContent(drawer?.props.children as ReactNode)).toContain("Claude Opus 4.7");
    const modelButtons = findElements(
      drawer?.props.children as ReactNode,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.split(/\s+/).includes("model-option"),
    );
    expect(modelButtons.map((button) => textContent(button))).toEqual([
      "GPT-5.6Configured roles: defaultopenai/gpt-5.6",
      "Claude Opus 4.7anthropic/claude-opus-4.7",
    ]);
    expect(textContent(drawer?.props.children as ReactNode)).not.toContain("Effort");
  });

  it("uses mobile bottom sheets for model and effort selectors", () => {
    reactHarness.isMobile = true;
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Model")?.props).toMatchObject({
      showSwipeHandle: true,
      swipeDirection: "down",
    });

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Effort")?.props).toMatchObject({
      showSwipeHandle: true,
      swipeDirection: "down",
    });
  });

  it("keeps only the most recently opened configuration drawer open", () => {
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Model")?.props.open).toBe(true);
    expect(findConfigurationDrawer(output, "Effort")?.props.open).toBe(false);

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Model")?.props.open).toBe(false);
    expect(findConfigurationDrawer(output, "Effort")?.props.open).toBe(true);
    expect(findConfigurationDrawer(output, "Effort")?.props).toMatchObject({
      showSwipeHandle: false,
      swipeDirection: "right",
    });
  });

  it("opens truthful recovery guidance when configuration data is unavailable", () => {
    const staleProps = configurationProps(BASE_SESSION);
    let output = renderControlledDashboard(staleProps);

    expect(findConfigurationTrigger(output, "model")?.props.disabled).not.toBe(true);
    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(staleProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).toMatch(
      /restart/i,
    );

    const disconnectedLiveSession: Session = {
      ...BASE_SESSION,
      connected: false,
      status: "disconnected",
    };
    const disconnectedLiveProps = configurationProps(disconnectedLiveSession);
    output = renderControlledDashboard(disconnectedLiveProps);
    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(disconnectedLiveProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).toMatch(
      /restart/i,
    );

    output = renderControlledDashboard(disconnectedLiveProps);
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(disconnectedLiveProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).toMatch(
      /restart/i,
    );

    const historySession: Session = {
      ...BASE_SESSION,
      connected: false,
      source: "history",
      status: "history",
    };
    const historyProps = configurationProps(historySession);
    output = renderControlledDashboard(historyProps);
    expect(findConfigurationTrigger(output, "effort")?.props.disabled).not.toBe(true);
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(historyProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).toMatch(
      /resume/i,
    );
  });

  it("sends only an effort command when an available effort is selected", async () => {
    const onSetModel = vi.fn().mockResolvedValue(undefined);
    const onSetEffort = vi.fn().mockResolvedValue(undefined);
    const props = configurationProps(CONFIGURABLE_SESSION, { onSetModel, onSetEffort });
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const effortDrawerText = textContent(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
    );
    expect(effortDrawerText).toContain("Extra high");
    expect(effortDrawerText).not.toContain("Claude Opus 4.7");
    expect(effortDrawerText).not.toContain("Max");
    const highOption = findElements(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
      (element) => textContent(element) === "High",
    )[0];
    (highOption?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onSetEffort).toHaveBeenCalledWith(CONFIGURABLE_SESSION.id, "high");
    expect(onSetModel).not.toHaveBeenCalled();
  });

  it("shows request errors only in the drawer that initiated them", async () => {
    const modelProps = configurationProps(CONFIGURABLE_SESSION, {
      onSetModel: vi.fn().mockRejectedValue(new Error("Model request failed")),
    });
    let output = renderControlledDashboard(modelProps);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(modelProps, { preserveState: true, effectsEnabled: false });
    const alternateModel = findElements(
      findConfigurationDrawer(output, "Model")?.props.children as ReactNode,
      (element) =>
        typeof element.props.onClick === "function" && textContent(element).includes("Claude Opus 4.7"),
    )[0];
    (alternateModel?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    output = renderControlledDashboard(modelProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).toContain(
      "Model request failed",
    );

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(modelProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).not.toContain(
      "Model request failed",
    );

    const effortProps = configurationProps(CONFIGURABLE_SESSION, {
      onSetEffort: vi.fn().mockRejectedValue(new Error("Effort request failed")),
    });
    output = renderControlledDashboard(effortProps);
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(effortProps, { preserveState: true, effectsEnabled: false });
    const highEffort = findElements(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "High",
    )[0];
    (highEffort?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    output = renderControlledDashboard(effortProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).toContain(
      "Effort request failed",
    );

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(effortProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).not.toContain(
      "Effort request failed",
    );
  });

  it("ignores stale configuration completions after switching sessions", async () => {
    let rejectFirstModelRequest: (reason: Error) => void = () => undefined;
    const firstModelRequest = new Promise<void>((_resolve, reject) => {
      rejectFirstModelRequest = reject;
    });
    let resolveSecondEffortRequest: () => void = () => undefined;
    const secondEffortRequest = new Promise<void>((resolve) => {
      resolveSecondEffortRequest = resolve;
    });
    const secondSession: Session = {
      ...CONFIGURABLE_SESSION,
      id: "session-2",
      name: "Second session",
    };
    const firstProps: ControlledDashboardProps = {
      ...configurationProps(CONFIGURABLE_SESSION),
      sessions: [CONFIGURABLE_SESSION, secondSession],
      onSetModel: vi.fn().mockReturnValue(firstModelRequest),
    };
    let output = renderControlledDashboard(firstProps);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
    const alternateModel = findElements(
      findConfigurationDrawer(output, "Model")?.props.children as ReactNode,
      (element) =>
        typeof element.props.onClick === "function" && textContent(element).includes("Claude Opus 4.7"),
    )[0];
    (alternateModel?.props.onClick as (() => void) | undefined)?.();

    const secondProps: ControlledDashboardProps = {
      ...firstProps,
      selectedSessionId: secondSession.id,
      onSetEffort: vi.fn().mockReturnValue(secondEffortRequest),
    };
    renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    const highEffort = findElements(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "High",
    )[0];
    (highEffort?.props.onClick as (() => void) | undefined)?.();

    rejectFirstModelRequest(new Error("Old session model failure"));
    await Promise.resolve();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    const effortDrawer = findConfigurationDrawer(output, "Effort");
    expect(textContent(effortDrawer?.props.children as ReactNode)).not.toContain("Old session model failure");
    expect(
      findElements(effortDrawer?.props.children as ReactNode, (element) => textContent(element) === "High")[0]
        ?.props.disabled,
    ).toBe(true);

    resolveSecondEffortRequest();
    await Promise.resolve();
  });
});
