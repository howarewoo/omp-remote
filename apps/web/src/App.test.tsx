import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";

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
  useSessionClient: () => ({
    sessions: [],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected",
    error: null,
    launch: vi.fn(),
    command: vi.fn(),
    abort: vi.fn(),
    kill: vi.fn(),
    searchHistory: vi.fn(),
    loadMoreHistory: vi.fn(),
    loadTranscript: vi.fn(),
  }),
}));

vi.mock("@omp-remote/sessions/components", () => ({ Dashboard: vi.fn() }));
vi.mock("./session-notifications.js", () => ({
  useSessionNotifications: () => ({ state: "enabled", enable: vi.fn() }),
}));

interface ControlledDashboardProps {
  selectedSessionId?: string | null;
  onSelectedSessionChange?: (sessionId: string) => void;
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

    expect((App() as ReactElement<ControlledDashboardProps>).props.selectedSessionId).toBe(
      "team/a?b=c & café%done",
    );
  });

  it("replaces only the session query parameter and preserves unrelated parameters", () => {
    const location = new URL("https://app.test/?view=compact&session=stale&panel=activity");
    const replaceState = vi.fn((_state: unknown, _unused: string, target: string | URL) => {
      const replacement = new URL(target, location);
      location.href = replacement.href;
    });
    vi.stubGlobal("window", { location, history: { replaceState } });
    const props = (App() as ReactElement<ControlledDashboardProps>).props;

    expect(props.onSelectedSessionChange).toBeTypeOf("function");
    props.onSelectedSessionChange?.("session 2/β");

    expect(replaceState).toHaveBeenCalledOnce();
    expect(location.searchParams.get("session")).toBe("session 2/β");
    expect(location.searchParams.get("view")).toBe("compact");
    expect(location.searchParams.get("panel")).toBe("activity");
    expect([...location.searchParams.keys()]).toEqual(["view", "session", "panel"]);
  });
});
