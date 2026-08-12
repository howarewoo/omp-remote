import {
  type NotificationEvent,
  type NotificationEventKey,
  type PushEventPreferences,
  type PushSubscription as PushSubscriptionPayload,
  PushSubscriptionSchema,
} from "@omp-remote/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type SessionNotificationState = "blocked" | "enabled" | "error" | "prompt" | "unsupported";

export const NOTIFICATION_EVENT_KEYS = [
  "inputRequired",
  "sessionIdle",
] as const satisfies readonly NotificationEventKey[];
export const NOTIFICATION_PREFERENCES_STORAGE_KEY = "omp-remote.notification-preferences";
export const NOTIFICATION_PREFERENCES_VERSION = 2;

export type NotificationEventPreferences = PushEventPreferences;

export interface NotificationPreferencesRecord {
  version: typeof NOTIFICATION_PREFERENCES_VERSION;
  deviceId: string;
  vapidPublicKey: string;
  events: NotificationEventPreferences;
}

export interface SessionNotificationClient {
  connection: "connecting" | "connected" | "disconnected";
  subscribeNotificationEvents(listener: (event: NotificationEvent) => void): () => void;
  pushVapidPublicKey(): Promise<string>;
  registerPushSubscription(registration: {
    deviceId: string;
    subscription: PushSubscriptionPayload;
    events: PushEventPreferences;
  }): Promise<void>;
  updatePushSubscription(update: {
    deviceId: string;
    subscription: PushSubscriptionPayload;
    events: PushEventPreferences;
  }): Promise<void>;
  removePushSubscription(removal: { deviceId: string }): Promise<void>;
}

export interface SessionNotifications {
  state: SessionNotificationState;
  preferences: NotificationEventPreferences;
  error: string | null;
  toggleEvent(event: NotificationEventKey, enabled: boolean): Promise<void>;
}

export interface NotificationStatusSnapshot {
  state: SessionNotificationState;
  preferences: NotificationEventPreferences;
  error: string | null;
}
export interface NotificationOperationQueue {
  run(
    operation: () => Promise<NotificationStatusSnapshot>,
    commit: (snapshot: NotificationStatusSnapshot) => void,
  ): Promise<NotificationStatusSnapshot>;
}

export function createNotificationOperationQueue(): NotificationOperationQueue {
  let tail = Promise.resolve();
  return {
    run(operation, commit) {
      const result = tail.then(async () => {
        const snapshot = await operation();
        commit(snapshot);
        return snapshot;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

type StoredNotificationRegistration =
  | { status: "missing" | "invalid" }
  | { status: "valid"; registration: NotificationPreferencesRecord };

const EMPTY_PREFERENCES: NotificationEventPreferences = { inputRequired: false, sessionIdle: false };
const ENABLE_ERROR = "Could not enable push notifications on this device. Try again.";
const SYNC_ERROR = "Could not sync notification settings with the host. Try again.";
const VAPID_CHANGED_ERROR =
  "The host push key changed. Turn notifications off, then enable them again on this device.";

function readStoredNotificationRegistration(): StoredNotificationRegistration {
  if (typeof window === "undefined") return { status: "missing" };
  try {
    const stored = window.localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY);
    if (!stored) return { status: "missing" };
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return { status: "invalid" };
    const record = parsed as Record<string, unknown>;
    const events = record.events;
    if (
      record.version !== NOTIFICATION_PREFERENCES_VERSION ||
      typeof record.deviceId !== "string" ||
      record.deviceId.length === 0 ||
      typeof record.vapidPublicKey !== "string" ||
      record.vapidPublicKey.length === 0 ||
      !events ||
      typeof events !== "object"
    ) {
      return { status: "invalid" };
    }
    const eventRecord = events as Record<string, unknown>;
    if (typeof eventRecord.inputRequired !== "boolean" || typeof eventRecord.sessionIdle !== "boolean") {
      return { status: "invalid" };
    }
    return {
      status: "valid",
      registration: {
        version: NOTIFICATION_PREFERENCES_VERSION,
        deviceId: record.deviceId,
        vapidPublicKey: record.vapidPublicKey,
        events: {
          inputRequired: eventRecord.inputRequired,
          sessionIdle: eventRecord.sessionIdle,
        },
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

/** Reads only current, versioned per-device preferences. Older preference-only records stay off. */
export function readNotificationPreferences(): NotificationEventPreferences | null {
  const stored = readStoredNotificationRegistration();
  return stored.status === "valid" ? stored.registration.events : null;
}

export function writeNotificationRegistration(record: NotificationPreferencesRecord): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      NOTIFICATION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: NOTIFICATION_PREFERENCES_VERSION,
        deviceId: record.deviceId,
        vapidPublicKey: record.vapidPublicKey,
        events: {
          inputRequired: record.events.inputRequired === true,
          sessionIdle: record.events.sessionIdle === true,
        },
      } satisfies NotificationPreferencesRecord),
    );
    return true;
  } catch {
    return false;
  }
}

function notificationApi(): typeof Notification | null {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  return window.Notification;
}

export function isPushNotificationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    notificationApi() !== null &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function initialSnapshot(): NotificationStatusSnapshot {
  const stored = readStoredNotificationRegistration();
  const preferences = stored.status === "valid" ? stored.registration.events : EMPTY_PREFERENCES;
  if (!isPushNotificationSupported()) {
    return { state: "unsupported", preferences: EMPTY_PREFERENCES, error: null };
  }
  if (notificationApi()?.permission === "denied") {
    return { state: "blocked", preferences, error: null };
  }
  return { state: "prompt", preferences, error: null };
}

export function vapidPublicKeyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  try {
    const padded = `${publicKey}${"=".repeat((4 - (publicKey.length % 4)) % 4)}`;
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength !== 65) throw new Error("Invalid byte length");
    return bytes;
  } catch {
    throw new Error("The host returned an invalid push public key");
  }
}

function pushSubscriptionPayload(subscription: PushSubscription) {
  const browserSubscription = subscription.toJSON();
  return PushSubscriptionSchema.parse({
    endpoint: browserSubscription.endpoint,
    keys: browserSubscription.keys,
  });
}

function messageOf(failure: unknown, fallback: string): string {
  if (!(failure instanceof Error) || failure.message.trim().length === 0) return fallback;
  return failure.message.length <= 500 ? failure.message : `${failure.message.slice(0, 499)}…`;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

function hasEnabledPreference(preferences: NotificationEventPreferences): boolean {
  return preferences.inputRequired || preferences.sessionIdle;
}

async function unsubscribePush(subscription: PushSubscription): Promise<void> {
  if (!(await subscription.unsubscribe())) {
    throw new Error("The browser did not remove its push subscription");
  }
}

async function cleanupPushRegistration(
  client: SessionNotificationClient,
  deviceId: string | null,
  subscription: PushSubscription | null,
): Promise<void> {
  const failures: string[] = [];
  if (deviceId) {
    try {
      await client.removePushSubscription({ deviceId });
    } catch (failure) {
      failures.push(messageOf(failure, "The host did not remove this device"));
    }
  }
  if (subscription) {
    try {
      await unsubscribePush(subscription);
    } catch (failure) {
      failures.push(messageOf(failure, "The browser did not remove its push subscription"));
    }
  }
  if (failures.length > 0) throw new Error(failures.join(" Cleanup also failed: "));
}

async function updateAndPersistPushPreferences(
  client: SessionNotificationClient,
  stored: NotificationPreferencesRecord,
  subscription: PushSubscription,
  next: NotificationEventPreferences,
): Promise<void> {
  const subscriptionPayload = pushSubscriptionPayload(subscription);
  await client.updatePushSubscription({
    deviceId: stored.deviceId,
    subscription: subscriptionPayload,
    events: next,
  });
  if (writeNotificationRegistration({ ...stored, events: next })) return;
  try {
    await client.updatePushSubscription({
      deviceId: stored.deviceId,
      subscription: subscriptionPayload,
      events: stored.events,
    });
  } catch (rollbackFailure) {
    throw new Error(
      `Notification settings could not be saved on this device. Host rollback failed: ${messageOf(
        rollbackFailure,
        "unknown host error",
      )}`,
    );
  }
  throw new Error("Notification settings could not be saved on this device");
}

/** Re-registers an existing browser subscription after reload but never creates one. */
export async function reconcilePushNotifications(
  client: SessionNotificationClient,
): Promise<NotificationStatusSnapshot> {
  const baseline = initialSnapshot();
  if (baseline.state === "unsupported" || client.connection !== "connected") return baseline;
  const stored = readStoredNotificationRegistration();
  const preferences = stored.status === "valid" ? stored.registration.events : EMPTY_PREFERENCES;
  try {
    const registration = await readyRegistration();
    const subscription = await registration.pushManager.getSubscription();
    const permission = notificationApi()?.permission;
    if (permission !== "granted") {
      await cleanupPushRegistration(
        client,
        stored.status === "valid" ? stored.registration.deviceId : null,
        subscription,
      );
      return {
        state: permission === "denied" ? "blocked" : "prompt",
        preferences,
        error: null,
      };
    }
    if (stored.status !== "valid") {
      await cleanupPushRegistration(client, null, subscription);
      return { state: "prompt", preferences: EMPTY_PREFERENCES, error: null };
    }
    if (!hasEnabledPreference(stored.registration.events)) {
      await cleanupPushRegistration(client, stored.registration.deviceId, subscription);
      return { state: "prompt", preferences: stored.registration.events, error: null };
    }
    if (!subscription) {
      await cleanupPushRegistration(client, stored.registration.deviceId, null);
      return { state: "prompt", preferences: stored.registration.events, error: null };
    }
    const publicKey = await client.pushVapidPublicKey();
    if (publicKey !== stored.registration.vapidPublicKey) {
      return { state: "error", preferences: stored.registration.events, error: VAPID_CHANGED_ERROR };
    }
    await client.registerPushSubscription({
      deviceId: stored.registration.deviceId,
      subscription: pushSubscriptionPayload(subscription),
      events: stored.registration.events,
    });
    return { state: "enabled", preferences: stored.registration.events, error: null };
  } catch (failure) {
    return { state: "error", preferences, error: messageOf(failure, SYNC_ERROR) };
  }
}

async function grantedPermission(): Promise<NotificationPermission> {
  const notification = notificationApi();
  if (!notification) return "denied";
  if (notification.permission !== "default") return notification.permission;
  return notification.requestPermission();
}

/** Performs one explicit per-device subscribe/update/remove operation. */
export async function changePushPreference(
  client: SessionNotificationClient,
  event: NotificationEventKey,
  enabled: boolean,
): Promise<NotificationStatusSnapshot> {
  if (!isPushNotificationSupported()) {
    return { state: "unsupported", preferences: EMPTY_PREFERENCES, error: null };
  }
  const stored = readStoredNotificationRegistration();
  const current = stored.status === "valid" ? stored.registration.events : EMPTY_PREFERENCES;
  const next = { ...current, [event]: enabled };

  if (enabled) {
    try {
      const permission = await grantedPermission();
      if (permission !== "granted") {
        return {
          state: permission === "denied" ? "blocked" : "prompt",
          preferences: current,
          error: null,
        };
      }
      const registration = await readyRegistration();
      let subscription = await registration.pushManager.getSubscription();
      const publicKey = await client.pushVapidPublicKey();
      const canUpdate =
        subscription !== null &&
        stored.status === "valid" &&
        stored.registration.vapidPublicKey === publicKey;
      if (!canUpdate) {
        if (subscription) await unsubscribePush(subscription);
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidPublicKeyBytes(publicKey),
        });
      }
      if (!subscription) throw new Error("The browser did not create a push subscription");
      const deviceId = stored.status === "valid" ? stored.registration.deviceId : window.crypto.randomUUID();
      if (canUpdate && stored.status === "valid") {
        await updateAndPersistPushPreferences(client, stored.registration, subscription, next);
      } else {
        const daemonRegistration = {
          deviceId,
          subscription: pushSubscriptionPayload(subscription),
          events: next,
        };
        try {
          await client.registerPushSubscription(daemonRegistration);
        } catch (failure) {
          try {
            await cleanupPushRegistration(client, deviceId, subscription);
          } catch (cleanupFailure) {
            throw new Error(
              `${messageOf(failure, ENABLE_ERROR)} Cleanup also failed: ${messageOf(
                cleanupFailure,
                "unknown cleanup error",
              )}`,
            );
          }
          throw failure;
        }
        if (
          !writeNotificationRegistration({
            version: NOTIFICATION_PREFERENCES_VERSION,
            deviceId,
            vapidPublicKey: publicKey,
            events: next,
          })
        ) {
          await cleanupPushRegistration(client, deviceId, subscription);
          throw new Error("Notification settings could not be saved on this device");
        }
      }
      return { state: "enabled", preferences: next, error: null };
    } catch (failure) {
      return { state: "error", preferences: current, error: messageOf(failure, ENABLE_ERROR) };
    }
  }

  try {
    const registration = await readyRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (stored.status !== "valid") {
      await cleanupPushRegistration(client, null, subscription);
      return { state: "prompt", preferences: EMPTY_PREFERENCES, error: null };
    }
    const permission = notificationApi()?.permission;
    if (permission !== "granted") {
      await cleanupPushRegistration(client, stored.registration.deviceId, subscription);
      if (!writeNotificationRegistration({ ...stored.registration, events: next })) {
        throw new Error("Notification settings could not be saved on this device");
      }
      return {
        state: permission === "denied" ? "blocked" : "prompt",
        preferences: next,
        error: null,
      };
    }
    if (hasEnabledPreference(next)) {
      if (!subscription) {
        await cleanupPushRegistration(client, stored.registration.deviceId, null);
        if (!writeNotificationRegistration({ ...stored.registration, events: next })) {
          throw new Error("Notification settings could not be saved on this device");
        }
        return { state: "prompt", preferences: next, error: null };
      }
      const publicKey = await client.pushVapidPublicKey();
      await updateAndPersistPushPreferences(client, stored.registration, subscription, next);
      return publicKey === stored.registration.vapidPublicKey
        ? { state: "enabled", preferences: next, error: null }
        : { state: "error", preferences: next, error: VAPID_CHANGED_ERROR };
    }

    await cleanupPushRegistration(client, stored.registration.deviceId, subscription);
    if (!writeNotificationRegistration({ ...stored.registration, events: next })) {
      throw new Error("Notification settings could not be saved on this device");
    }
    return { state: "prompt", preferences: next, error: null };
  } catch (failure) {
    return { state: "error", preferences: current, error: messageOf(failure, SYNC_ERROR) };
  }
}

export const SESSION_NOTIFICATION_OPTIONS = {
  icon: "/icon-192.png",
  badge: "/icon-192.png",
} as const;

/** Shows one foreground fallback only when this browser has no active Push subscription. */
export async function deliverForegroundNotification(
  notification: NotificationEvent,
  preferences: NotificationEventPreferences,
): Promise<"ignored" | "push-active" | "shown"> {
  if (!preferences[notification.event] || !isPushNotificationSupported()) return "ignored";
  if (notificationApi()?.permission !== "granted") return "ignored";
  const registration = await readyRegistration();
  if (await registration.pushManager.getSubscription()) return "push-active";
  await registration.showNotification(notification.title, {
    ...SESSION_NOTIFICATION_OPTIONS,
    body: notification.body,
    tag: notification.tag,
    data: { url: notification.url },
  });
  return "shown";
}

/** Synchronizes this installed browser with daemon-authored notification events. */
export function useSessionNotifications(client: SessionNotificationClient): SessionNotifications {
  const [snapshot, setSnapshot] = useState<NotificationStatusSnapshot>(initialSnapshot);
  const preferencesRef = useRef(snapshot.preferences);
  const operationQueueRef = useRef<NotificationOperationQueue | null>(null);
  const notificationClient = useMemo<SessionNotificationClient>(
    () => ({
      connection: client.connection,
      subscribeNotificationEvents: client.subscribeNotificationEvents,
      pushVapidPublicKey: client.pushVapidPublicKey,
      registerPushSubscription: client.registerPushSubscription,
      updatePushSubscription: client.updatePushSubscription,
      removePushSubscription: client.removePushSubscription,
    }),
    [
      client.connection,
      client.subscribeNotificationEvents,
      client.pushVapidPublicKey,
      client.registerPushSubscription,
      client.removePushSubscription,
      client.updatePushSubscription,
    ],
  );

  const applySnapshot = useCallback((next: NotificationStatusSnapshot) => {
    preferencesRef.current = next.preferences;
    setSnapshot(next);
  }, []);
  operationQueueRef.current ??= createNotificationOperationQueue();
  const operationQueue = operationQueueRef.current;

  useEffect(() => {
    if (notificationClient.connection !== "connected") return;
    let disposed = false;
    const reconcile = () => {
      void operationQueue
        .run(
          () => reconcilePushNotifications(notificationClient),
          (next) => {
            if (!disposed) applySnapshot(next);
          },
        )
        .catch(() => undefined);
    };
    reconcile();
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [applySnapshot, notificationClient, operationQueue]);

  useEffect(
    () =>
      notificationClient.subscribeNotificationEvents((notification) => {
        void deliverForegroundNotification(notification, preferencesRef.current).catch((failure: unknown) => {
          setSnapshot((current) => ({
            ...current,
            state: "error",
            error: messageOf(failure, "Could not display a session notification."),
          }));
        });
      }),
    [notificationClient],
  );

  const toggleEvent = useCallback(
    async (event: NotificationEventKey, enabled: boolean) => {
      await operationQueue.run(() => changePushPreference(notificationClient, event, enabled), applySnapshot);
    },
    [applySnapshot, notificationClient, operationQueue],
  );

  return { ...snapshot, toggleEvent };
}
