import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";

const appMocks = vi.hoisted(() => {
  const sessionClient = {
    sessions: [],
    askRequests: [],
    savedWorkingDirectories: [],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected",
    error: null,
    launch: vi.fn(),
    saveWorkingDirectory: vi.fn(),
    removeWorkingDirectory: vi.fn(),
    command: vi.fn(),
    abort: vi.fn(),
    kill: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    respondToAsk: vi.fn(),
    askActivity: vi.fn(),
    searchHistory: vi.fn(),
    loadMoreHistory: vi.fn(),
    loadTranscript: vi.fn(),
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
  };
  return { sessionClient, useSessionNotifications: vi.fn() };
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
}));
vi.mock("./session-notifications.js", () => ({
  useSessionNotifications: appMocks.useSessionNotifications.mockReturnValue({
    state: "enabled",
    preferences: { inputRequired: true, sessionIdle: true },
    error: null,
    toggleEvent: vi.fn(),
  }),
}));

interface ControlledDashboardProps {
  selectedSessionId?: string | null;
  onLoadSession?: (sessionId: string) => Promise<void>;
  onLoadSessionFileChanges?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  onLoadSessionBranchTopology?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  onSwitchBranch?: (sessionId: string, branch: string) => Promise<void>;
  onSelectedSessionChange?: (sessionId: string) => void;
}

interface AppContentProps {
  children: [ReactElement<ControlledDashboardProps>, ReactElement<{ ready: boolean }>];
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

    const [dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.selectedSessionId).toBe("team/a?b=c & café%done");
  });

  it("replaces only the session query parameter and preserves unrelated parameters", () => {
    const location = new URL("https://app.test/?view=compact&session=stale&panel=activity");
    const replaceState = vi.fn((_state: unknown, _unused: string, target: string | URL) => {
      const replacement = new URL(target, location);
      location.href = replacement.href;
    });
    vi.stubGlobal("window", { location, history: { replaceState } });
    const [dashboard] = (App() as ReactElement<AppContentProps>).props.children;
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

    const [, splash] = (App() as ReactElement<AppContentProps>).props.children;

    expect(splash.props.ready).toBe(true);
  });

  it("wires exact session loading into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.onLoadSession).toBe(appMocks.sessionClient.loadSession);
  });

  it("wires the session-derived file changes client into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [dashboard] = (App() as ReactElement<AppContentProps>).props.children;
    expect(dashboard.props.onLoadSessionFileChanges).toBeTypeOf("function");
  });

  it("wires branch topology loading and switching into the dashboard", () => {
    vi.stubGlobal("window", {
      location: new URL("https://app.test/"),
      history: { replaceState: vi.fn() },
    });

    const [dashboard] = (App() as ReactElement<AppContentProps>).props.children;
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
});
