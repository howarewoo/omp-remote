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
    expect(askRow?.props.scrollAnchor).toBeFalsy();
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
    reactHarness.lifecycleEffects = true;
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
    reactHarness.lifecycleEffects = true;
    const onLoadCost = vi.fn().mockResolvedValue(undefined);
    const message: Session["messages"][number] = {
      id: "message-1",
      role: "user",
      text: "Transcript input",
      presentation: "text",
      timestamp: "2026-07-31T12:00:00.000Z",
      streaming: false,
    };
    const secondSession: Session = {
      ...BASE_SESSION,
      id: "session-2",
      name: "Second session",
      messages: [message],
    };
    const props = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadCost,
    };

    renderControlledDashboard(props);
    expect(onLoadCost).not.toHaveBeenCalled();

    renderControlledDashboard(
      {
        ...props,
        sessions: [{ ...BASE_SESSION, messages: [message] }, secondSession],
      },
      { preserveState: true },
    );
    expect(onLoadCost.mock.calls).toEqual([[BASE_SESSION.id]]);

    renderControlledDashboard(
      {
        ...props,
        sessions: [{ ...BASE_SESSION, messages: [message] }, secondSession],
        selectedSessionId: secondSession.id,
      },
      { preserveState: true },
    );
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
