import type { Session } from "@omp-remote/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type SessionNotificationState = "blocked" | "enabled" | "error" | "prompt" | "unsupported";

export interface SessionNotificationEvent {
  title: "Input required" | "Session idle";
  body: string;
  tag: string;
}

export interface SessionNotifications {
  state: SessionNotificationState;
  enable(): Promise<void>;
}

/** Returns user-relevant status transitions without alerting for snapshots or inactive sessions. */
export function findSessionNotifications(
  previousSessions: readonly Session[] | null,
  sessions: readonly Session[],
): SessionNotificationEvent[] {
  if (!previousSessions) return [];
  const previousById = new Map(previousSessions.map((session) => [session.id, session]));
  const notifications: SessionNotificationEvent[] = [];

  for (const session of sessions) {
    const previous = previousById.get(session.id);
    if (!previous || !session.connected || session.source === "history") continue;
    const displayName = session.name ?? session.cwd;

    if (session.status === "waiting" && previous.status !== "waiting") {
      notifications.push({
        title: "Input required",
        body: `${displayName} is waiting for input.`,
        tag: `session-${session.id}-waiting`,
      });
    } else if (previous.status === "running" && session.status === "idle") {
      notifications.push({
        title: "Session idle",
        body: `${displayName} finished and is idle.`,
        tag: `session-${session.id}-idle`,
      });
    }
  }

  return notifications;
}

/** Watches live sessions and delivers opted-in browser notifications for actionable transitions. */
export function useSessionNotifications(sessions: readonly Session[]): SessionNotifications {
  const previousSessionsRef = useRef<readonly Session[] | null>(null);
  const [state, setState] = useState<SessionNotificationState>(readNotificationState);

  useEffect(() => {
    const syncPermission = () => setState(readNotificationState());
    document.addEventListener("visibilitychange", syncPermission);
    return () => document.removeEventListener("visibilitychange", syncPermission);
  }, []);

  useEffect(() => {
    const previousSessions = previousSessionsRef.current;
    previousSessionsRef.current = sessions;
    if (state !== "enabled") return;

    for (const notification of findSessionNotifications(previousSessions, sessions)) {
      void showSessionNotification(notification).catch((error: unknown) => {
        console.error("Could not show session notification", error);
      });
    }
  }, [sessions, state]);

  const enable = useCallback(async () => {
    if (!("Notification" in window)) {
      setState("unsupported");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      setState(permission === "granted" ? "enabled" : permission === "denied" ? "blocked" : "prompt");
    } catch (error) {
      console.error("Could not request notification permission", error);
      setState("error");
    }
  }, []);

  return { state, enable };
}

function readNotificationState(): SessionNotificationState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "enabled";
  if (Notification.permission === "denied") return "blocked";
  return "prompt";
}

async function showSessionNotification(notification: SessionNotificationEvent): Promise<void> {
  const options: NotificationOptions = {
    body: notification.body,
    icon: "/icon-192.png",
    tag: notification.tag,
    data: { url: "/" },
  };
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.showNotification(notification.title, options);
    return;
  }
  new Notification(notification.title, options);
}
