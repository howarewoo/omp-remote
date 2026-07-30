import type { Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSessionNotifications, useSessionNotifications } from "./session-notifications.js";

const notificationHook = vi.hoisted(() => ({
  previousSessions: { current: null as readonly Session[] | null },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: Parameters<typeof actual.useEffect>[0]) => void effect(),
    useRef: () => notificationHook.previousSessions,
    useState: () => ["enabled", vi.fn()],
  };
});

const BASE_SESSION: Session = {
  id: "session-1",
  source: "extension",
  name: "Notification work",
  cwd: "/work/omp-remote",
  branch: "change/session-notifications",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-30T12:00:00.000Z",
  lastActivity: "2026-07-30T12:01:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

const WORKER_SESSION: Session = {
  ...BASE_SESSION,
  id: "session-worker",
  name: "NotificationWorker",
  sessionPath: "/work/.omp/session/NotificationWorker.jsonl",
};

const ACTIVE_WORKER = {
  id: WORKER_SESSION.id,
  name: "NotificationWorker",
  lastActivity: WORKER_SESSION.lastActivity,
};

describe("findSessionNotifications", () => {
  it("notifies when a running session becomes idle", () => {
    expect(findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, status: "idle" }])).toEqual([
      {
        title: "Session idle",
        body: "Notification work finished and is idle.",
        tag: "session-session-1-idle",
        url: "/?session=session-1",
      },
    ]);
  });

  it("notifies whenever a connected session starts waiting for input", () => {
    expect(findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, status: "waiting" }])).toEqual([
      {
        title: "Input required",
        body: "Notification work is waiting for input.",
        tag: "session-session-1-waiting",
        url: "/?session=session-1",
      },
    ]);
  });

  it("does not notify for a nested worker before active membership is synchronized", () => {
    expect(
      findSessionNotifications(
        [BASE_SESSION, WORKER_SESSION],
        [BASE_SESSION, { ...WORKER_SESSION, status: "idle" }],
      ),
    ).toEqual([]);
  });

  it("does not notify for a nested worker after active membership clears", () => {
    const parentWithWorker = { ...BASE_SESSION, activeSubagents: [ACTIVE_WORKER] };

    expect(
      findSessionNotifications(
        [parentWithWorker, WORKER_SESSION],
        [BASE_SESSION, { ...WORKER_SESSION, status: "waiting" }],
      ),
    ).toEqual([]);
  });

  it("does not notify for a nested worker when its parent is absent from one snapshot", () => {
    expect(
      findSessionNotifications([BASE_SESSION, WORKER_SESSION], [{ ...WORKER_SESSION, status: "waiting" }]),
    ).toEqual([]);
    expect(
      findSessionNotifications([WORKER_SESSION], [BASE_SESSION, { ...WORKER_SESSION, status: "waiting" }]),
    ).toEqual([]);
  });

  it("keeps parent notifications while suppressing its nested worker", () => {
    expect(
      findSessionNotifications(
        [BASE_SESSION, WORKER_SESSION],
        [
          { ...BASE_SESSION, status: "idle" },
          { ...WORKER_SESSION, status: "waiting" },
        ],
      ),
    ).toEqual([
      {
        title: "Session idle",
        body: "Notification work finished and is idle.",
        tag: "session-session-1-idle",
        url: "/?session=session-1",
      },
    ]);
  });

  it("encodes reserved and Unicode session ID characters exactly once", () => {
    const session = { ...BASE_SESSION, id: "team/a?b=c & café%done" };

    expect(findSessionNotifications([session], [{ ...session, status: "waiting" }])[0]?.url).toBe(
      "/?session=team%2Fa%3Fb%3Dc+%26+caf%C3%A9%25done",
    );
  });

  it("does not notify for snapshots, repeated states, new sessions, history, or disconnected sessions", () => {
    expect(findSessionNotifications(null, [BASE_SESSION])).toEqual([]);
    expect(findSessionNotifications([BASE_SESSION], [BASE_SESSION])).toEqual([]);
    expect(
      findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, id: "new-session", status: "waiting" }]),
    ).toEqual([]);
    expect(
      findSessionNotifications(
        [{ ...BASE_SESSION, source: "history" }],
        [{ ...BASE_SESSION, source: "history", status: "idle" }],
      ),
    ).toEqual([]);
    expect(
      findSessionNotifications(
        [{ ...BASE_SESSION, connected: false }],
        [{ ...BASE_SESSION, connected: false, status: "idle" }],
      ),
    ).toEqual([]);
  });

  it("falls back to the working directory when a session has no name", () => {
    const unnamed = { ...BASE_SESSION, name: null };

    expect(findSessionNotifications([unnamed], [{ ...unnamed, status: "waiting" }])[0]?.body).toBe(
      "/work/omp-remote is waiting for input.",
    );
  });
});

describe("direct Notification fallback", () => {
  afterEach(() => {
    notificationHook.previousSessions.current = null;
    vi.unstubAllGlobals();
  });

  it("closes, navigates to the encoded session URL, and focuses the app window", async () => {
    let browserNotification:
      | {
          close: Mock;
          onclick: ((event: Event) => void) | null;
        }
      | undefined;
    let href = "https://app.test/?view=compact";
    const location = {
      get href() {
        return href;
      },
      set href(url: string) {
        href = new URL(url, href).href;
      },
      assign(url: string) {
        this.href = url;
      },
    };
    const focus = vi.fn();
    const notificationConstructor = vi.fn();
    class NotificationMock {
      static permission = "granted";
      static requestPermission = vi.fn();
      close = vi.fn();
      onclick: ((event: Event) => void) | null = null;

      constructor() {
        notificationConstructor();
        browserNotification = this;
      }
    }
    vi.stubGlobal("window", { Notification: NotificationMock, location, focus });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("Notification", NotificationMock);
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) },
    });

    const session = { ...BASE_SESSION, id: "team/a?b=c & café%done" };
    useSessionNotifications([session]);
    useSessionNotifications([{ ...session, status: "waiting" }]);

    await vi.waitFor(() => expect(notificationConstructor).toHaveBeenCalledOnce());
    expect(browserNotification?.onclick).toBeTypeOf("function");

    browserNotification?.onclick?.(new Event("click"));

    expect(browserNotification?.close).toHaveBeenCalledOnce();
    expect(location.href).toBe("https://app.test/?session=team%2Fa%3Fb%3Dc+%26+caf%C3%A9%25done");
    expect(focus).toHaveBeenCalledOnce();
  });
});
