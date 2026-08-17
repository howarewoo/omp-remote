// biome-ignore-all assist/source/organizeImports: The test support must install the React hook mock first.
import {
  BASE_SESSION,
  type ControlledDashboardProps,
  composerDashboardProps,
  DASHBOARD_DEFAULTS,
  findElements,
  findHostText,
  getReactHarness,
  renderControlledDashboard,
  SELECT_ASK,
  textContent,
} from "./dashboard-test-support.js";
import type { Session } from "@omp-remote/protocol";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskToolCall, type DashboardProps } from "../dashboard.js";
import { ApplicationErrorViewer } from "../application-error-viewer.js";
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
    expect(askRow?.props.scrollAnchor).toBe(true);
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

  it("keeps a connected metadata-only session selected while hydrating it once", () => {
    const onLoadTranscript = vi.fn(() => new Promise<void>(() => undefined));
    const props = {
      ...composerDashboardProps({ ...BASE_SESSION, messages: [] }),
      onLoadTranscript,
    };

    const output = renderControlledDashboard(props);
    renderControlledDashboard(props, { preserveState: true });

    const selectedSidebarSession = findElements(
      output,
      (element) => element.props.className === "session-item session-item-selected",
    )[0];
    expect(findHostText(output, "h1")).toBe(BASE_SESSION.name);
    expect(selectedSidebarSession?.props["aria-label"]).toBe("Bootstrap, Idle");
    expect(textContent(output)).toContain("Host connected");
    expect(onLoadTranscript).toHaveBeenCalledOnce();
    expect(onLoadTranscript).toHaveBeenCalledWith(BASE_SESSION.id);
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

  it("preserves the selected session when a new session is prepended to the list", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected" as const,
      error: null,
      notificationState: "enabled" as const,
      selectedSessionId: BASE_SESSION.id,
      onSelectedSessionChange,
    };

    renderControlledDashboard(props);
    const newSession = { ...BASE_SESSION, id: "session-2", name: "New live session" };
    const output = renderControlledDashboard(
      { ...props, sessions: [newSession, BASE_SESSION] },
      { preserveState: true },
    );

    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(onSelectedSessionChange).not.toHaveBeenCalled();
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

  beforeEach(() => {
    vi.spyOn(toast, "error").mockReturnValue("toast-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("opens the launch dialog from the mobile sidebar", () => {
    reactHarness.isMobile = true;
    const props = { ...baseProps, onLaunch: vi.fn() };
    let output = renderControlledDashboard(props);
    const sidebarActions = findElements(
      output,
      (element) => element.props.className === "sidebar-actions",
    )[0];
    const newSessionButton = findElements(
      sidebarActions,
      (element) => textContent(element) === "New session",
    )[0];

    (newSessionButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(
      findElements(output, (element) => element.props.title === "Start an OMP session")[0]?.props.open,
    ).toBe(true);
  });

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
    expect(toast.error).not.toHaveBeenCalled();
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
    expect(toast.error).not.toHaveBeenCalled();
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
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith("resume failed");
    renderControlledDashboard(
      {
        ...baseProps,
        sessions: [historySession],
        selectedSessionId: historySession.id,
      },
      { preserveState: true, effectsEnabled: false },
    );
    expect(toast.error).toHaveBeenCalledOnce();
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
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith("launch failed");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(toast.error).toHaveBeenCalledOnce();
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
      roles: ["default", "slow"],
      roleEfforts: { default: "high", slow: "xhigh" },
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

function findConfigurationTrigger(output: ReactNode) {
  return findElements(
    output,
    (element) =>
      typeof element.props["aria-label"] === "string" &&
      element.props["aria-label"].startsWith("Change model and effort."),
  )[0];
}

function findConfigurationDrawer(output: ReactNode) {
  return findElements(
    output,
    (element) =>
      element.type === Drawer &&
      textContent(element.props.children as ReactNode).includes("Model and effort"),
  )[0];
}

function findRoleOption(output: ReactNode, role: string) {
  return findElements(
    output,
    (element) =>
      typeof element.props.className === "string" &&
      element.props.className.split(/\s+/).includes("role-option") &&
      textContent(element).includes(`@${role}`),
  )[0];
}

function findAdHocDisclosure(output: ReactNode, modelName: string) {
  return findElements(
    output,
    (element) =>
      element.props.className === "model-option-disclosure" && textContent(element).includes(modelName),
  )[0];
}

describe("session model and effort selector", () => {
  it("renders one metadata button for the active model and effort", () => {
    const output = renderControlledDashboard(configurationProps(CONFIGURABLE_SESSION));

    expect(findConfigurationTrigger(output)?.props.disabled).not.toBe(true);
    expect(findConfigurationTrigger(output)?.props["aria-label"]).toContain("current effort Medium");
    expect(
      findElements(output, (element) => element.type === "dt").map((element) => textContent(element)),
    ).toEqual(["Branch", "Model · Effort", "Context", "Changes", "Cost"]);
  });

  it("shows configured role buttons with their effort before ad hoc models", () => {
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const drawer = findConfigurationDrawer(output);
    const drawerText = textContent(drawer?.props.children as ReactNode);
    const defaultRole = findRoleOption(drawer?.props.children as ReactNode, "default");
    expect(drawer?.props.open).toBe(true);
    expect(drawer?.props).toMatchObject({ showSwipeHandle: false, swipeDirection: "right" });
    expect(drawerText.indexOf("Configured roles")).toBeLessThan(drawerText.indexOf("Ad hoc model"));
    expect(textContent(defaultRole)).toContain("@defaultGPT-5.6openai/gpt-5.6High");
    expect(textContent(findRoleOption(drawer?.props.children as ReactNode, "slow"))).toContain(
      "@slowGPT-5.6openai/gpt-5.6Extra high",
    );
    expect(typeof defaultRole?.props.onClick).toBe("function");
    expect(drawerText).toContain("Claude Opus 4.7");
  });

  it("asks legacy sessions to restart instead of reporting inherited role effort", () => {
    const legacySession: Session = {
      ...CONFIGURABLE_SESSION,
      availableModels: CONFIGURABLE_SESSION.availableModels?.map((model) =>
        model.roles ? { ...model, roleEfforts: undefined } : model,
      ),
    };
    const props = configurationProps(legacySession);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const drawer = findConfigurationDrawer(output);
    const defaultRoleText = textContent(findRoleOption(drawer?.props.children as ReactNode, "default"));
    expect(defaultRoleText).toContain("Restart session");
    expect(defaultRoleText).not.toContain("Inherit");
  });

  it("uses one mobile bottom sheet for model and effort", () => {
    reactHarness.isMobile = true;
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output)?.props).toMatchObject({
      showSwipeHandle: true,
      swipeDirection: "down",
    });
  });

  it("requires an effort choice before applying an ad hoc model", async () => {
    const onSetModel = vi.fn().mockResolvedValue(undefined);
    const onSetEffort = vi.fn().mockResolvedValue(undefined);
    const props = configurationProps(CONFIGURABLE_SESSION, { onSetModel, onSetEffort });
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const disclosure = findAdHocDisclosure(
      findConfigurationDrawer(output)?.props.children as ReactNode,
      "Claude Opus 4.7",
    );
    expect(disclosure?.props.open).toBe(false);
    (disclosure?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(true);
    expect(onSetModel).not.toHaveBeenCalled();
    expect(onSetEffort).not.toHaveBeenCalled();

    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const expandedDisclosure = findAdHocDisclosure(
      findConfigurationDrawer(output)?.props.children as ReactNode,
      "Claude Opus 4.7",
    );
    expect(expandedDisclosure?.props.open).toBe(true);
    const maxEffort = findElements(
      expandedDisclosure,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Max",
    )[0];
    (maxEffort?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSetModel).toHaveBeenCalledWith(CONFIGURABLE_SESSION.id, "anthropic/claude-opus-4.7");
    expect(onSetEffort).toHaveBeenCalledWith(CONFIGURABLE_SESSION.id, "max");
    expect(onSetModel.mock.invocationCallOrder[0]).toBeLessThan(onSetEffort.mock.invocationCallOrder[0] ?? 0);
  });

  it("applies a configured role without asking for effort", async () => {
    const onSetModel = vi.fn().mockResolvedValue(undefined);
    const onSetEffort = vi.fn().mockResolvedValue(undefined);
    const props = configurationProps(CONFIGURABLE_SESSION, { onSetModel, onSetEffort });
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const roleOption = findRoleOption(
      findConfigurationDrawer(output)?.props.children as ReactNode,
      "default",
    );
    (roleOption?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onSetModel).toHaveBeenCalledWith(CONFIGURABLE_SESSION.id, "@default");
    expect(onSetEffort).not.toHaveBeenCalled();
  });

  it("opens truthful combined recovery guidance when configuration data is unavailable", () => {
    const staleProps = configurationProps(BASE_SESSION);
    let output = renderControlledDashboard(staleProps);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(staleProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output)?.props.children as ReactNode)).toMatch(/restart/i);

    const historySession: Session = {
      ...BASE_SESSION,
      connected: false,
      source: "history",
      status: "history",
    };
    const historyProps = configurationProps(historySession);
    output = renderControlledDashboard(historyProps);
    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(historyProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output)?.props.children as ReactNode)).toMatch(/resume/i);
  });

  it("keeps combined request errors in the selector", async () => {
    const props = configurationProps(CONFIGURABLE_SESSION, {
      onSetModel: vi.fn().mockRejectedValue(new Error("Model request failed")),
    });
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const disclosure = findAdHocDisclosure(
      findConfigurationDrawer(output)?.props.children as ReactNode,
      "Claude Opus 4.7",
    );
    (disclosure?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(true);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const maxEffort = findElements(
      findAdHocDisclosure(findConfigurationDrawer(output)?.props.children as ReactNode, "Claude Opus 4.7"),
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Max",
    )[0];
    (maxEffort?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(textContent(findConfigurationDrawer(output)?.props.children as ReactNode)).toContain(
      "Model request failed",
    );
  });

  it("ignores stale configuration completions after switching sessions", async () => {
    let rejectFirstModelRequest: (reason: Error) => void = () => undefined;
    const firstModelRequest = new Promise<void>((_resolve, reject) => {
      rejectFirstModelRequest = reject;
    });
    let resolveSecondRoleRequest: () => void = () => undefined;
    const secondRoleRequest = new Promise<void>((resolve) => {
      resolveSecondRoleRequest = resolve;
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

    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
    const firstDisclosure = findAdHocDisclosure(
      findConfigurationDrawer(output)?.props.children as ReactNode,
      "Claude Opus 4.7",
    );
    (firstDisclosure?.props.onOpenChange as ((open: boolean) => void) | undefined)?.(true);
    output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
    const firstMaxEffort = findElements(
      findAdHocDisclosure(findConfigurationDrawer(output)?.props.children as ReactNode, "Claude Opus 4.7"),
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Max",
    )[0];
    (firstMaxEffort?.props.onClick as (() => void) | undefined)?.();

    const secondProps: ControlledDashboardProps = {
      ...firstProps,
      selectedSessionId: secondSession.id,
      onSetModel: vi.fn().mockReturnValue(secondRoleRequest),
    };
    renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    (findConfigurationTrigger(output)?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    const secondRole = findRoleOption(
      findConfigurationDrawer(output)?.props.children as ReactNode,
      "default",
    );
    (secondRole?.props.onClick as (() => void) | undefined)?.();

    rejectFirstModelRequest(new Error("Old session model failure"));
    await Promise.resolve();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    const drawer = findConfigurationDrawer(output);
    expect(textContent(drawer?.props.children as ReactNode)).not.toContain("Old session model failure");
    expect(findRoleOption(drawer?.props.children as ReactNode, "default")?.props.disabled).toBe(true);

    resolveSecondRoleRequest();
    await Promise.resolve();
  });
});

describe("directory session filter rail", () => {
  const multiDirSessions: Session[] = [
    {
      ...BASE_SESSION,
      id: "session-alpha-1",
      name: "Alpha 1",
      cwd: "/work/alpha",
      lastActivity: "2026-07-28T10:00:00.000Z",
    },
    {
      ...BASE_SESSION,
      id: "session-beta-1",
      name: "Beta 1",
      cwd: "/work/beta",
      lastActivity: "2026-07-28T14:00:00.000Z",
    },
    {
      ...BASE_SESSION,
      id: "session-alpha-2",
      name: "Alpha 2",
      cwd: "/work/alpha",
      lastActivity: "2026-07-28T16:00:00.000Z",
    },
  ];

  it("renders directory rail buttons with All first and directory initials and tooltips", () => {
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-alpha-2",
      onSelectedSessionChange: vi.fn(),
    });

    const rail = findElements(output, (el) => el.props.className === "directory-rail")[0];
    expect(rail).toBeDefined();

    const railButtons = findElements(
      rail,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );
    expect(railButtons).toHaveLength(3);

    expect(railButtons[0]?.props["aria-label"]).toBe("All sessions, 3 live sessions");
    expect(railButtons[0]?.props["aria-current"]).toBe("true");

    expect(railButtons[1]?.props["aria-label"]).toBe("/work/alpha, 2 live sessions");
    expect(textContent(railButtons[1])).toContain("AL");

    expect(railButtons[2]?.props["aria-label"]).toBe("/work/beta, 1 live session");
    expect(textContent(railButtons[2])).toContain("BE");

    const tooltips = findElements(rail, (el) => typeof el.props.content === "string");
    expect(tooltips.map((tooltip) => tooltip.props.content)).toEqual([
      "All sessions (3 live sessions)",
      "/work/alpha (2 live sessions)",
      "/work/beta (1 live session)",
    ]);
  });

  it("filters existing sections client-side and selects the first visible session upon clicking a directory", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-alpha-2",
      onSelectedSessionChange,
    };

    let output = renderControlledDashboard(props);
    const railButtons = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );

    (railButtons[2]?.props.onClick as (() => void) | undefined)?.();
    expect(onSelectedSessionChange).toHaveBeenCalledWith("session-beta-1");

    output = renderControlledDashboard(
      { ...props, selectedSessionId: "session-beta-1" },
      { preserveState: true, effectsEnabled: false },
    );

    const sidebarSessions = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("session-item"),
    );
    expect(sidebarSessions).toHaveLength(1);
    expect(textContent(sidebarSessions[0])).toContain("Beta 1");
  });

  it("returns to All without overriding a selected session outside the active directory", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-alpha-2",
      onSelectedSessionChange,
    };

    const initialOutput = renderControlledDashboard(props);
    const railButtons = findElements(
      initialOutput,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );
    (railButtons[2]?.props.onClick as (() => void) | undefined)?.();
    onSelectedSessionChange.mockClear();

    renderControlledDashboard(props, { preserveState: true });
    const recoveredOutput = renderControlledDashboard(props, {
      preserveState: true,
      effectsEnabled: false,
    });

    const recoveredRailButtons = findElements(
      recoveredOutput,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );
    expect(recoveredRailButtons[0]?.props["aria-current"]).toBe("true");
    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const selectedSessionItem = findElements(recoveredOutput, (el) => el.props["aria-current"] === "page")[0];
    expect(textContent(selectedSessionItem)).toContain("Alpha 2");
  });

  it("recovers to All and selects the first global session when the active directory disappears", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-beta-1",
      onSelectedSessionChange,
    };

    let output = renderControlledDashboard(props);
    const railButtons = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );

    (railButtons[2]?.props.onClick as (() => void) | undefined)?.();

    const updatedSessions = multiDirSessions.filter((s) => s.cwd !== "/work/beta");
    output = renderControlledDashboard(
      { ...props, sessions: updatedSessions, selectedSessionId: "session-beta-1" },
      { preserveState: true },
    );

    expect(onSelectedSessionChange).toHaveBeenCalledWith("session-alpha-1");
  });

  it("returns to All when the selected directory no longer has a connected session", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-beta-1",
      onSelectedSessionChange,
    };

    const initialOutput = renderControlledDashboard(props);
    const initialRailButtons = findElements(
      initialOutput,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );
    (initialRailButtons[2]?.props.onClick as (() => void) | undefined)?.();
    onSelectedSessionChange.mockClear();

    const sessionsWithDisconnectedBeta = multiDirSessions.map((session) =>
      session.id === "session-beta-1" ? { ...session, connected: false } : session,
    );
    renderControlledDashboard({ ...props, sessions: sessionsWithDisconnectedBeta }, { preserveState: true });
    const recoveredOutput = renderControlledDashboard(
      { ...props, sessions: sessionsWithDisconnectedBeta },
      { preserveState: true, effectsEnabled: false },
    );

    const recoveredRailButtons = findElements(
      recoveredOutput,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );
    expect(recoveredRailButtons).toHaveLength(2);
    expect(recoveredRailButtons[0]?.props["aria-current"]).toBe("true");
    expect(recoveredRailButtons[0]?.props["aria-label"]).toBe("All sessions, 2 live sessions");
    expect(onSelectedSessionChange).not.toHaveBeenCalled();
  });
  it("keeps search global upstream and excludes loaded history from directory counts", async () => {
    const onSearchHistory = vi.fn().mockResolvedValue(undefined);
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-alpha-1",
      onSearchHistory,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);

    const searchInput = findElements(output, (el) => el.props.id === "session-search-input")[0];
    (searchInput?.props.onChange as ((e: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "query" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const searchForm = findElements(output, (el) => el.props.className === "session-search")[0];
    (searchForm?.props.onSubmit as ((e: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });

    expect(onSearchHistory).toHaveBeenCalledWith("query");

    const historySession: Session = {
      ...BASE_SESSION,
      id: "session-history-1",
      name: "History Session",
      cwd: "/work/history-project",
      source: "history",
      status: "history",
      connected: false,
      lastActivity: "2026-07-28T18:00:00.000Z",
    };

    output = renderControlledDashboard(
      { ...props, sessions: [...multiDirSessions, historySession] },
      { preserveState: true, effectsEnabled: false },
    );

    const railButtons = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );
    expect(railButtons).toHaveLength(3);
    expect(railButtons[0]?.props["aria-label"]).toBe("All sessions, 3 live sessions");
    expect(
      railButtons.some(
        (button) =>
          typeof button.props["aria-label"] === "string" &&
          button.props["aria-label"].includes("/work/history-project"),
      ),
    ).toBe(false);
  });

  it("keeps the mobile sheet open on directory selection but closes it on session selection", () => {
    reactHarness.isMobile = true;
    const onSelectedSessionChange = vi.fn();
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-alpha-1",
      onSelectedSessionChange,
    };

    const output = renderControlledDashboard(props);
    const railButtons = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("directory-rail-button"),
    );

    (railButtons[2]?.props.onClick as (() => void) | undefined)?.();
    expect(reactHarness.setOpenMobile).not.toHaveBeenCalled();

    const sessionItems = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("session-item"),
    );
    (sessionItems[0]?.props.onClick as (() => void) | undefined)?.();
    expect(reactHarness.setOpenMobile).toHaveBeenCalledWith(false);
  });

  it("preserves the directory rail layout in the sidebar pane structure", () => {
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: multiDirSessions,
      sessionsReady: true,
      selectedSessionId: "session-alpha-1",
      onSelectedSessionChange: vi.fn(),
    });

    const railPane = findElements(output, (el) => el.props.className === "sidebar-rail-pane")[0];
    const sessionPane = findElements(output, (el) => el.props.className === "sidebar-session-pane")[0];

    expect(railPane).toBeDefined();
    expect(sessionPane).toBeDefined();
  });
});

describe("dashboard application errors view navigation", () => {
  const sampleErrors = [
    {
      id: "err-1",
      timestamp: "2026-08-17T12:00:00.000Z",
      source: "daemon" as const,
      severity: "error" as const,
      message: "Socket connection lost",
    },
    {
      id: "err-2",
      timestamp: "2026-08-17T13:00:00.000Z",
      source: "browser" as const,
      severity: "fatal" as const,
      message: "Renderer crashed",
    },
  ];

  it("transitions between sessions and application errors view without clearing selection", () => {
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      selectedSessionId: "session-1",
      applicationErrors: sampleErrors,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);
    expect(findHostText(output, "h1")).toBe("Bootstrap");

    // Find the sidebar Errors button in footer
    const errorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    expect(errorsTrigger).toBeDefined();
    expect(errorsTrigger?.props["aria-label"]).toBe("Application errors, 2 recorded");
    expect(errorsTrigger?.props["aria-current"]).toBeUndefined();

    // Click Errors button to switch view
    (errorsTrigger?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // ApplicationErrorViewer is rendered in the dashboard inset
    const viewerElement = findElements(output, (el) => el.type === ApplicationErrorViewer)[0];
    expect(viewerElement).toBeDefined();
    expect(viewerElement?.props.errors).toEqual(sampleErrors);

    // Active view attribute on trigger is set
    const activeErrorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    expect(activeErrorsTrigger?.props["aria-current"]).toBe("page");

    // Click a session from the list to return to sessions view
    const sessionItem = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("session-item"),
    )[0];
    (sessionItem?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    // Sessions view is restored with selected session intact
    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(findElements(output, (el) => el.type === ApplicationErrorViewer)).toHaveLength(0);
  });

  it("returns to sessions view when back button in error viewer is clicked", () => {
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      selectedSessionId: "session-1",
      applicationErrors: sampleErrors,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);
    const errorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    (errorsTrigger?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const viewerElement = findElements(output, (el) => el.type === ApplicationErrorViewer)[0];
    expect(viewerElement).toBeDefined();

    // Trigger onBackToSessions on the viewer
    (viewerElement?.props.onBackToSessions as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(findElements(output, (el) => el.type === ApplicationErrorViewer)).toHaveLength(0);
  });

  it("retains connection status in sidebar footer when viewing application errors", () => {
    const props = {
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      sessionsReady: true,
      connection: "connected" as const,
      selectedSessionId: "session-1",
      applicationErrors: sampleErrors,
      onSelectedSessionChange: vi.fn(),
    };

    let output = renderControlledDashboard(props);
    const errorsTrigger = findElements(
      output,
      (el) => typeof el.props.className === "string" && el.props.className.includes("sidebar-errors-trigger"),
    )[0];
    (errorsTrigger?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const connectionStatus = findElements(
      output,
      (el) => el.props.className === "sidebar-connection-status",
    )[0];
    expect(connectionStatus).toBeDefined();
    expect(textContent(connectionStatus)).toContain("Host connected");
  });
});
