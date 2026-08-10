import { getMainSessionIds, type AskRequest, type Session } from "@omp-remote/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type SessionNotificationState = "blocked" | "enabled" | "error" | "prompt" | "unsupported";
export type NotificationEventKey = "inputRequired" | "sessionIdle";

export const NOTIFICATION_EVENT_KEYS = [
  "inputRequired",
  "sessionIdle",
] as const satisfies readonly NotificationEventKey[];
export const NOTIFICATION_PREFERENCES_STORAGE_KEY = "omp-remote.notification-preferences";
export const NOTIFICATION_PREFERENCES_VERSION = 1;

export type NotificationEventPreferences = Record<NotificationEventKey, boolean>;

export interface NotificationPreferencesRecord {
  version: typeof NOTIFICATION_PREFERENCES_VERSION;
  events: NotificationEventPreferences;
}

export interface SessionNotificationEvent {
  title: "Input required" | "Session idle";
  body: string;
  tag: string;
  url: string;
}

export interface SessionNotifications {
  state: SessionNotificationState;
  preferences: NotificationEventPreferences;
  error: string | null;
  toggleEvent(event: NotificationEventKey, enabled: boolean): Promise<void>;
}

function sessionUrl(sessionId: string): string {
  return `/?${new URLSearchParams({ session: sessionId })}`;
}

type StoredNotificationPreferences =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; preferences: NotificationEventPreferences };

function readStoredNotificationPreferences(): StoredNotificationPreferences {
  if (typeof window === "undefined") return { status: "missing" };
  try {
    const stored = window.localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== NOTIFICATION_PREFERENCES_VERSION ||
      !("events" in parsed) ||
      !parsed.events ||
      typeof parsed.events !== "object"
    ) {
      return { status: "invalid" };
    }

    const events = parsed.events as Record<string, unknown>;
    return {
      status: "valid",
      preferences: {
        inputRequired: events.inputRequired === true,
        sessionIdle: events.sessionIdle === true,
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

/** Reads the versioned, device-local event preferences without trusting unknown event keys. */
export function readNotificationPreferences(): NotificationEventPreferences | null {
  const stored = readStoredNotificationPreferences();
  return stored.status === "valid" ? stored.preferences : null;
}

/** Stores only the current event keys so future keys stay opt-in by default. */
export function writeNotificationPreferences(preferences: NotificationEventPreferences): void {
  if (typeof window === "undefined") return;

  try {
    const record: NotificationPreferencesRecord = {
      version: NOTIFICATION_PREFERENCES_VERSION,
      events: {
        inputRequired: preferences.inputRequired === true,
        sessionIdle: preferences.sessionIdle === true,
      },
    };
    window.localStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Browser storage can be unavailable in private browsing or restrictive embeds.
  }
}

function clearNotificationPreferences(): void {
  writeNotificationPreferences(emptyNotificationPreferences());
}
function emptyNotificationPreferences(): NotificationEventPreferences {
  return { inputRequired: false, sessionIdle: false };
}

function notificationApi(): typeof Notification | null {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return window.Notification;
}

function permissionState(): SessionNotificationState {
  const notification = notificationApi();
  if (!notification) return "unsupported";
  if (notification.permission === "granted") return "enabled";
  if (notification.permission === "denied") return "blocked";
  return "prompt";
}
function preferencesForState(state: SessionNotificationState): NotificationEventPreferences {
  if (state !== "enabled") return emptyNotificationPreferences();
  const stored = readStoredNotificationPreferences();
  if (stored.status === "valid") return stored.preferences;
  if (stored.status === "missing") {
    const defaults = { inputRequired: true, sessionIdle: true };
    writeNotificationPreferences(defaults);
    return defaults;
  }
  return emptyNotificationPreferences();
}

function askIdentity(request: AskRequest): string {
  const record = request as unknown as Record<string, unknown>;
  const sessionId = String(record.sessionId ?? "");
  for (const key of ["requestId", "askId", "toolCallId", "callId", "messageId", "id"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return `${sessionId}:${key}:${value}`;
  }

  const stableKeys = Object.keys(record)
    .filter((key) => key !== "expiresAt")
    .sort()
    .map((key) => [key, record[key]]);
  return `${sessionId}:legacy:${JSON.stringify(stableKeys)}`;
}

function askTag(request: AskRequest): string {
  const value = (request as unknown as Record<string, unknown>).requestId;
  return typeof value === "string" || typeof value === "number" ? String(value) : askIdentity(request);
}
/** Returns user-relevant status transitions and Ask requests without alerting for snapshots or inactive sessions. */
export function findSessionNotifications(
  previousSessions: readonly Session[] | null,
  sessions: readonly Session[],
  previousAskRequests: readonly AskRequest[] | null = [],
  askRequests: readonly AskRequest[] = [],
): SessionNotificationEvent[] {
  if (!previousSessions) return [];
  const previousById = new Map(previousSessions.map((session) => [session.id, session]));
  const currentById = new Map(sessions.map((session) => [session.id, session]));
  const rootSessionIds = getMainSessionIds([...previousSessions, ...sessions]);
  const previousAskIdentities = new Set((previousAskRequests ?? []).map(askIdentity));
  const notifications: SessionNotificationEvent[] = [];
  const inputRequiredSessionIds = new Set<string>();

  for (const request of askRequests) {
    const session = currentById.get(request.sessionId);
    if (
      !session ||
      !rootSessionIds.has(session.id) ||
      !session.connected ||
      session.source === "history" ||
      previousAskIdentities.has(askIdentity(request))
    )
      continue;

    const displayName = session.name ?? session.cwd;
    inputRequiredSessionIds.add(session.id);
    notifications.push({
      title: "Input required",
      body: `${displayName} is waiting for input.`,
      tag: `session-${session.id}-ask-${askTag(request)}`,
      url: sessionUrl(session.id),
    });
  }

  for (const session of sessions) {
    const previous = previousById.get(session.id);
    if (!previous || !rootSessionIds.has(session.id) || !session.connected || session.source === "history")
      continue;
    const displayName = session.name ?? session.cwd;

    if (session.status === "waiting" && previous.status !== "waiting") {
      if (!inputRequiredSessionIds.has(session.id)) {
        notifications.push({
          title: "Input required",
          body: `${displayName} is waiting for input.`,
          tag: `session-${session.id}-waiting`,
          url: sessionUrl(session.id),
        });
      }
    } else if (previous.status === "running" && session.status === "idle") {
      notifications.push({
        title: "Session idle",
        body: `${displayName} finished and is idle.`,
        tag: `session-${session.id}-idle`,
        url: sessionUrl(session.id),
      });
    }
  }

  return notifications;
}

/** Watches live sessions and delivers opted-in browser notifications for actionable transitions. */
export function useSessionNotifications(
  sessions: readonly Session[],
  askRequests: readonly AskRequest[] = [],
): SessionNotifications {
  const previousSessionsRef = useRef<readonly Session[] | null>(null);
  const previousAskRequestsRef = useRef<readonly AskRequest[] | null>(null);
  const seenAskRequestsRef = useRef(new Map<string, AskRequest>());
  const initialState = permissionState();
  const [state, setState] = useState<SessionNotificationState>(initialState);
  const [preferences, setPreferences] = useState<NotificationEventPreferences>(() =>
    preferencesForState(initialState),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncPermission = () => {
      const nextState = permissionState();
      setState((current) => (current === "error" && nextState === "prompt" ? current : nextState));
      if (nextState !== "enabled") {
        clearNotificationPreferences();
        setPreferences(emptyNotificationPreferences());
        if (nextState !== "prompt") setError(null);
        return;
      }
      setPreferences(preferencesForState(nextState));
      setError(null);
    };
    document.addEventListener("visibilitychange", syncPermission);
    return () => document.removeEventListener("visibilitychange", syncPermission);
  }, []);

  useEffect(() => {
    const previousSessions = previousSessionsRef.current;
    const previousAskRequests = previousAskRequestsRef.current;
    const rememberedAskRequests = [...seenAskRequestsRef.current.values()];
    previousSessionsRef.current = sessions;
    previousAskRequestsRef.current = askRequests;
    const notifications = findSessionNotifications(
      previousSessions,
      sessions,
      rememberedAskRequests.length > 0 ? rememberedAskRequests : previousAskRequests,
      askRequests,
    );
    for (const request of askRequests) seenAskRequestsRef.current.set(askIdentity(request), request);
    if (state !== "enabled") return;

    for (const notification of notifications) {
      const event = notification.title === "Input required" ? "inputRequired" : "sessionIdle";
      if (!preferences[event]) continue;
      void showSessionNotification(notification).catch((failure: unknown) => {
        console.error("Could not show session notification", failure);
      });
    }
  }, [askRequests, preferences, sessions, state]);

  const toggleEvent = useCallback(async (event: NotificationEventKey, enabled: boolean) => {
    if (!enabled) {
      setPreferences((current) => {
        const next = { ...current, [event]: false };
        writeNotificationPreferences(next);
        return next;
      });
      return;
    }

    const currentPermission = permissionState();
    if (currentPermission === "unsupported" || currentPermission === "blocked") {
      clearNotificationPreferences();
      setState(currentPermission);
      setPreferences(emptyNotificationPreferences());
      return;
    }

    if (currentPermission === "prompt") {
      try {
        const notification = notificationApi();
        if (!notification) {
          clearNotificationPreferences();
          setPreferences(emptyNotificationPreferences());
          setState("unsupported");
          return;
        }
        const permission = await notification.requestPermission();
        if (permission !== "granted") {
          clearNotificationPreferences();
          setPreferences(emptyNotificationPreferences());
          setState(permission === "denied" ? "blocked" : "prompt");
          setError(null);
          return;
        }
      } catch (failure: unknown) {
        console.error("Could not request notification permission", failure);
        clearNotificationPreferences();
        setPreferences(emptyNotificationPreferences());
        setState("error");
        setError("Could not enable notifications. Try again.");
        return;
      }
    }

    setPreferences((current) => {
      const next = { ...current, [event]: true };
      writeNotificationPreferences(next);
      return next;
    });
    setState("enabled");
    setError(null);
  }, []);

  return { state, preferences, error, toggleEvent };
}

async function showSessionNotification(notification: SessionNotificationEvent): Promise<void> {
  const options: NotificationOptions = {
    body: notification.body,
    icon: "/icon-192.png",
    tag: notification.tag,
    data: { url: notification.url },
  };
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.showNotification(notification.title, options);
    return;
  }
  const notificationApiInstance = notificationApi();
  if (!notificationApiInstance) return;
  const browserNotification = new notificationApiInstance(notification.title, options);
  browserNotification.onclick = () => {
    browserNotification.close();
    window.location.href = notification.url;
    window.focus();
  };
}
