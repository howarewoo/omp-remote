import type { AskRequest, Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findSessionNotifications,
  NOTIFICATION_PREFERENCES_STORAGE_KEY,
  readNotificationPreferences,
  useSessionNotifications,
  writeNotificationPreferences,
} from "./session-notifications.js";

const notificationHook = vi.hoisted(() => ({
  previousSessions: { current: null as readonly Session[] | null },
  previousAskRequests: { current: null as readonly never[] | null },
  seenAskRequests: { current: new Map<string, never>() },
  refIndex: 0,
  stateIndex: 0,
  setters: [] as Mock[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: Parameters<typeof actual.useEffect>[0]) => void effect(),
    useRef: () => {
      const refs = [
        notificationHook.previousSessions,
        notificationHook.previousAskRequests,
        notificationHook.seenAskRequests,
      ];
      const ref = refs[notificationHook.refIndex % refs.length];
      notificationHook.refIndex += 1;
      return ref;
    },
    useState: () => {
      const browserPermission =
        typeof window !== "undefined" && window.Notification ? String(window.Notification.permission) : "";
      const initialPreferences =
        browserPermission === "prompt"
          ? { inputRequired: false, sessionIdle: false }
          : { inputRequired: true, sessionIdle: true };
      const values = ["enabled", initialPreferences, null] as const;
      const value = values[notificationHook.stateIndex % values.length];
      notificationHook.stateIndex += 1;
      const setter = vi.fn((update: unknown) => {
        if (typeof update === "function") (update as (value: unknown) => unknown)(value);
      });
      notificationHook.setters.push(setter);
      return [value, setter];
    },
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
  composerCommands: [],
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

const RICH_ASK = {
  sessionId: BASE_SESSION.id,
  requestId: "rich-ask",
  kind: "select",
  title: "Choose",
  options: ["A", "B"],
  initialValue: null,
  expiresAt: null,
} satisfies AskRequest;

const LEGACY_ASK = {
  sessionId: BASE_SESSION.id,
  title: "Legacy question",
  message: "Continue?",
} as unknown as AskRequest;

describe("Ask discovery and preference persistence", () => {
  it("deduplicates rich and legacy identities without alerting on initial snapshots", () => {
    expect(findSessionNotifications(null, [BASE_SESSION], [], [RICH_ASK])).toEqual([]);
    expect(findSessionNotifications([BASE_SESSION], [BASE_SESSION], [], [RICH_ASK])).toHaveLength(1);
    expect(findSessionNotifications([BASE_SESSION], [BASE_SESSION], [RICH_ASK], [RICH_ASK])).toEqual([]);
    expect(findSessionNotifications([BASE_SESSION], [BASE_SESSION], [], [LEGACY_ASK])).toHaveLength(1);
    expect(findSessionNotifications([BASE_SESSION], [BASE_SESSION], [LEGACY_ASK], [LEGACY_ASK])).toEqual([]);
  });

  it("collapses an Ask and waiting transition while preserving main-session filtering", () => {
    expect(
      findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, status: "waiting" }], [], [RICH_ASK]),
    ).toHaveLength(1);
    expect(
      findSessionNotifications(
        [BASE_SESSION, WORKER_SESSION],
        [
          { ...BASE_SESSION, status: "waiting" },
          { ...WORKER_SESSION, status: "waiting" },
        ],
        [],
        [{ ...RICH_ASK, sessionId: WORKER_SESSION.id }],
      ),
    ).toHaveLength(1);
    expect(
      findSessionNotifications(
        [{ ...BASE_SESSION, source: "history" }],
        [{ ...BASE_SESSION, source: "history" }],
        [],
        [RICH_ASK],
      ),
    ).toEqual([]);
    expect(
      findSessionNotifications(
        [{ ...BASE_SESSION, connected: false }],
        [{ ...BASE_SESSION, connected: false }],
        [],
        [RICH_ASK],
      ),
    ).toEqual([]);
  });

  it("defaults missing granted storage on once and keeps invalid records off", () => {
    let stored: string | null = null;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });
    writeNotificationPreferences({ inputRequired: true, sessionIdle: false });
    expect(readNotificationPreferences()).toEqual({ inputRequired: true, sessionIdle: false });
    stored = JSON.stringify({ version: 999, events: { inputRequired: true, sessionIdle: true } });
    expect(readNotificationPreferences()).toBeNull();
    expect(NOTIFICATION_PREFERENCES_STORAGE_KEY).toContain("notification-preferences");
    vi.unstubAllGlobals();
  });
});
function resetNotificationHook(): void {
  notificationHook.previousSessions.current = null;
  notificationHook.previousAskRequests.current = null;
  notificationHook.seenAskRequests.current.clear();
  notificationHook.refIndex = 0;
  notificationHook.stateIndex = 0;
  notificationHook.setters.length = 0;
}

function setupPermission(
  permission: NotificationPermission | "prompt",
  requestPermission: Mock = vi.fn().mockResolvedValue(permission === "prompt" ? "granted" : permission),
  initialStored: string | null = null,
): {
  notification: typeof Notification;
  getStored(): { events: { inputRequired: boolean; sessionIdle: boolean } } | null;
  resync(): void;
} {
  let stored: string | null = initialStored;
  let visibilityHandler: (() => void) | undefined;
  const notification = { permission, requestPermission } as unknown as typeof Notification;
  vi.stubGlobal("window", {
    Notification: notification,
    localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    },
  });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("document", {
    addEventListener: (_event: string, handler: () => void) => {
      visibilityHandler = handler;
    },
    removeEventListener: vi.fn(),
  });
  return {
    notification,
    getStored: () => (stored ? JSON.parse(stored) : null),
    resync: () => visibilityHandler?.(),
  };
}

describe("notification permission transitions", () => {
  afterEach(() => {
    resetNotificationHook();
    vi.unstubAllGlobals();
  });

  it("requests permission and persists only the selected event after a grant", async () => {
    resetNotificationHook();
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const browser = setupPermission("prompt", requestPermission);
    const notifications = useSessionNotifications([BASE_SESSION]);
    await notifications.toggleEvent("sessionIdle", true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(browser.getStored()?.events).toEqual({ inputRequired: false, sessionIdle: true });
  });

  it("clears stored events on denial, blocked, unsupported, and thrown request", async () => {
    const denied = setupPermission("prompt", vi.fn().mockResolvedValue("denied"));
    await useSessionNotifications([BASE_SESSION]).toggleEvent("inputRequired", true);
    expect(denied.getStored()?.events).toEqual({ inputRequired: false, sessionIdle: false });

    resetNotificationHook();
    const blocked = setupPermission("denied");
    await useSessionNotifications([BASE_SESSION]).toggleEvent("inputRequired", true);
    expect(blocked.getStored()?.events).toEqual({ inputRequired: false, sessionIdle: false });

    resetNotificationHook();
    let unsupportedStored: string | null = null;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: (_key: string, value: string) => {
          unsupportedStored = value;
        },
      },
    });
    await useSessionNotifications([BASE_SESSION]).toggleEvent("inputRequired", true);
    expect(unsupportedStored ? JSON.parse(unsupportedStored).events : null).toEqual({
      inputRequired: false,
      sessionIdle: false,
    });
    expect(notificationHook.setters[1]).toHaveBeenCalled();

    resetNotificationHook();
    const thrown = setupPermission("prompt", vi.fn().mockRejectedValue(new Error("denied by browser")));
    await useSessionNotifications([BASE_SESSION]).toggleEvent("inputRequired", true);
    expect(thrown.getStored()?.events).toEqual({ inputRequired: false, sessionIdle: false });
    expect(notificationHook.setters[2]).toHaveBeenCalledWith("Could not enable notifications. Try again.");
  });

  it("retries a thrown request and resynchronizes stored preferences on visibility", async () => {
    const requestPermission = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue("granted");
    const browser = setupPermission("prompt", requestPermission);
    const notifications = useSessionNotifications([BASE_SESSION]);
    await notifications.toggleEvent("inputRequired", true);
    await notifications.toggleEvent("inputRequired", true);
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(browser.getStored()?.events).toEqual({ inputRequired: true, sessionIdle: false });

    resetNotificationHook();
    const resync = setupPermission("denied");
    writeNotificationPreferences({ inputRequired: false, sessionIdle: true });
    useSessionNotifications([BASE_SESSION]);
    const mutableNotification = resync.notification as { permission: NotificationPermission };
    mutableNotification.permission = "granted";
    resync.resync();
    expect(notificationHook.setters[1]).toHaveBeenCalledWith({ inputRequired: false, sessionIdle: true });
    resetNotificationHook();
    const invalid = setupPermission(
      "granted",
      undefined,
      JSON.stringify({ version: 999, events: { inputRequired: true, sessionIdle: true } }),
    );
    useSessionNotifications([BASE_SESSION]);
    invalid.resync();
    expect(notificationHook.setters[1]).toHaveBeenCalledWith({ inputRequired: false, sessionIdle: false });

    resetNotificationHook();
    const missing = setupPermission("granted");
    useSessionNotifications([BASE_SESSION]);
    missing.resync();
    expect(notificationHook.setters[1]).toHaveBeenCalledWith({ inputRequired: true, sessionIdle: true });
    expect(missing.getStored()?.events).toEqual({ inputRequired: true, sessionIdle: true });
  });
});

describe("direct Notification fallback", () => {
  afterEach(() => {
    notificationHook.previousSessions.current = null;
    notificationHook.previousAskRequests.current = null;
    notificationHook.seenAskRequests.current.clear();
    notificationHook.refIndex = 0;
    notificationHook.stateIndex = 0;
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
