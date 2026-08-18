import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@omp-remote/sessions/components";
import App from "./App.js";

const appMocks = vi.hoisted(() => {
  const sessionClient = {
    sessions: [],
    queuedMessages: [],
    askRequests: [],
    savedWorkingDirectories: [],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected",
    error: null,
    transcriptHistory: {
      sessionId: null,
      initialLoading: false,
      olderLoading: false,
      status: null,
      error: null,
    },
    applicationErrors: [],
    applicationErrorsHealth: null,
    applicationErrorsLoading: false,
    applicationErrorsError: null,
    launch: vi.fn(),
    saveWorkingDirectory: vi.fn(),
    removeWorkingDirectory: vi.fn(),
    command: vi.fn(),
    abort: vi.fn(),
    cancelQueuedMessage: vi.fn(),
    kill: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    respondToAsk: vi.fn(),
    askActivity: vi.fn(),
    searchHistory: vi.fn(),
    loadMoreHistory: vi.fn(),
    loadTranscript: vi.fn(),
    loadOlderTranscript: vi.fn(),
    retryTranscript: vi.fn(),
    reloadTranscript: vi.fn(),
    loadSession: vi.fn(),
    loadCost: vi.fn(),
    loadSessionFileChanges: vi.fn(),
    loadSessionBranchTopology: vi.fn(),
    switchBranch: vi.fn(),
    subscribeNotificationEvents: vi.fn(),
    pushVapidPublicKey: vi.fn(),
    registerPushSubscription: vi.fn(),
    updatePushSubscription: vi.fn(),
    removePushSubscription: vi.fn(),
    clearApplicationErrors: vi.fn(),
    reportApplicationError: vi.fn(),
    loadApplicationErrors: vi.fn(),
  };
  return {
    sessionClient,
    useSessionNotifications: vi.fn(),
    useBrowserErrorCapture: vi.fn(),
  };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      vi.fn(),
    ],
  };
});

vi.mock("@omp-remote/session-client", () => ({
  useSessionClient: () => appMocks.sessionClient,
}));

vi.mock("@omp-remote/sessions/components", () => ({
  Dashboard: vi.fn(),
  ThemeProvider: ({ children }: { children: unknown }) => children,
  Toaster: vi.fn(),
}));
vi.mock("./session-notifications.js", () => ({
  useSessionNotifications: appMocks.useSessionNotifications.mockReturnValue({
    state: "enabled",
    preferences: { inputRequired: true, sessionIdle: true },
    error: null,
    toggleEvent: vi.fn(),
  }),
}));
vi.mock("./application-errors.js", () => ({
  useBrowserErrorCapture: appMocks.useBrowserErrorCapture,
}));

interface ControlledDashboardProps {
  selectedSessionId?: string | null;
  applicationErrors?: unknown[];
  applicationErrorsHealth?: unknown;
  applicationErrorsLoading?: boolean;
  applicationErrorsError?: string | null;
  onClearApplicationErrors?: () => Promise<void>;
  onReloadApplicationErrors?: () => Promise<void>;
  onLoadSession?: (sessionId: string) => Promise<void>;
  onLoadSessionFileChanges?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  onLoadSessionBranchTopology?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  onSwitchBranch?: (sessionId: string, branch: string) => Promise<void>;
  onSelectedSessionChange?: (sessionId: string) => void;
  transcriptHistory?: unknown;
  onLoadOlderTranscript?: () => Promise<void>;
  onRetryTranscript?: () => Promise<void>;
  onReloadTranscript?: () => Promise<void>;
}

interface AppContentProps {
  children: [ReactElement, ReactElement<ControlledDashboardProps>, ReactElement<{ ready: boolean }>];
}

describe("App session URL state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads and decodes the requested session from the URL", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/?session=team%2Fa%3Fb%3Dc+%26+caf%C3%A9%25done&view=compact"),
      history: { replaceState: vi.fn() },
    });

    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.selectedSessionId).toBe("team/a?b=c & café%done");
  });

  it("replaces only the session query parameter and preserves unrelated parameters", () => {
    const location = new URL("https://app.test/?view=compact&session=stale&panel=activity");
    const replaceState = vi.fn((_state: unknown, _unused: string, target: string | URL) => {
      const replacement = new URL(target, location);
      location.href = replacement.href;
    });
    vi.stubGlobal("window", { location, history: { replaceState } });
    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    const props = dashboard.props;

    expect(props.onSelectedSessionChange).toBeTypeOf("function");
    props.onSelectedSessionChange?.("session 2/β");

    expect(replaceState).toHaveBeenCalledOnce();
    expect(location.searchParams.get("session")).toBe("session 2/β");
    expect(location.searchParams.get("view")).toBe("compact");
    expect(location.searchParams.get("panel")).toBe("activity");
    expect([...location.searchParams.keys()]).toEqual(["view", "session", "panel"]);
  });

  it("dismisses the startup splash when the session catalog is ready", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [, , splash] = (App() as ReactElement<AppContentProps>).props.children;

    expect(splash.props.ready).toBe(true);
  });

  it("wires exact session loading into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.onLoadSession).toBe(appMocks.sessionClient.loadSession);
  });

  it("wires the session-derived file changes client into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.onLoadSessionFileChanges).toBeTypeOf("function");
  });

  it("wires branch topology loading and switching into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.onLoadSessionBranchTopology).toBeTypeOf("function");
    expect(dashboard.props.onSwitchBranch).toBeTypeOf("function");
  });

  it("passes the session client transport and notification listener contract to the Push hook", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    App();

    expect(appMocks.useSessionNotifications).toHaveBeenLastCalledWith(appMocks.sessionClient);
  });
  it("passes the session client transport to the browser error capture hook", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    App();

    expect(appMocks.useBrowserErrorCapture).toHaveBeenLastCalledWith(appMocks.sessionClient);
  });

  it("passes global application error records, health, loading, error, and actions to the dashboard independent of selected session", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/?session=active-session-123&query=filter"),
      history: { replaceState: vi.fn() },
    });

    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;

    expect(dashboard.props.applicationErrors).toBe(appMocks.sessionClient.applicationErrors);
    expect(dashboard.props.applicationErrorsHealth).toBe(appMocks.sessionClient.applicationErrorsHealth);
    expect(dashboard.props.applicationErrorsLoading).toBe(appMocks.sessionClient.applicationErrorsLoading);
    expect(dashboard.props.applicationErrorsError).toBe(appMocks.sessionClient.applicationErrorsError);
    expect(dashboard.props.onClearApplicationErrors).toBe(appMocks.sessionClient.clearApplicationErrors);
    expect(dashboard.props.onReloadApplicationErrors).toBe(appMocks.sessionClient.loadApplicationErrors);
    expect(dashboard.props.selectedSessionId).toBe("active-session-123");
  });

  it("wires transcript pagination state and actions into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [, dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.transcriptHistory).toBe(appMocks.sessionClient.transcriptHistory);
    expect(dashboard.props.onLoadOlderTranscript).toBe(appMocks.sessionClient.loadOlderTranscript);
    expect(dashboard.props.onRetryTranscript).toBe(appMocks.sessionClient.retryTranscript);
    expect(dashboard.props.onReloadTranscript).toBe(appMocks.sessionClient.reloadTranscript);
  });

  it("mounts exactly one root toaster inside the theme provider", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [toaster] = (App() as ReactElement<AppContentProps>).props.children;
    expect(toaster.type).toBe(Toaster);
  });
});
