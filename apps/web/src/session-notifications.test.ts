import type { NotificationEvent, PushSubscription as PushSubscriptionPayload } from "@omp-remote/protocol";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changePushPreference,
  createNotificationOperationQueue,
  deliverForegroundNotification,
  isPushNotificationSupported,
  NOTIFICATION_PREFERENCES_STORAGE_KEY,
  NOTIFICATION_PREFERENCES_VERSION,
  readNotificationPreferences,
  reconcilePushNotifications,
  SESSION_NOTIFICATION_OPTIONS,
  type SessionNotificationClient,
  vapidPublicKeyBytes,
  writeNotificationRegistration,
} from "./session-notifications.js";

const PUBLIC_KEY = "BOrK6yGWP_i0T7XjsNwdpM5g2-OC-F2sJBuCMH9SF2kb8qRfdHVZb-tPPOXQqvI8LNkoHqO5sP8rv7glORQUsLs";
const SUBSCRIPTION_JSON: PushSubscriptionPayload = {
  endpoint: "https://push.example/subscription",
  keys: {
    p256dh: PUBLIC_KEY,
    auth: "AQIDBAUGBwgJCgsMDQ4PEA",
  },
};
const BROWSER_SUBSCRIPTION_JSON = {
  ...SUBSCRIPTION_JSON,
  expirationTime: null,
};
const NOTIFICATION = {
  type: "notification_event",
  event: "inputRequired",
  title: "Input required",
  body: "Build is waiting for input.",
  tag: "session-session-1-ask-1",
  url: "/?session=session-1",
} satisfies NotificationEvent;

type SubscriptionMock = PushSubscription & { unsubscribe: Mock; toJSON: Mock };
type ClientMock = SessionNotificationClient & {
  pushVapidPublicKey: Mock;
  registerPushSubscription: Mock;
  updatePushSubscription: Mock;
  removePushSubscription: Mock;
};

function subscriptionMock(): SubscriptionMock {
  return {
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: vi.fn(() => BROWSER_SUBSCRIPTION_JSON),
  } as unknown as SubscriptionMock;
}
function clientMock(): ClientMock {
  return {
    connection: "connected",
    subscribeNotificationEvents: vi.fn(() => vi.fn()),
    pushVapidPublicKey: vi.fn().mockResolvedValue(PUBLIC_KEY),
    registerPushSubscription: vi.fn().mockResolvedValue(undefined),
    updatePushSubscription: vi.fn().mockResolvedValue(undefined),
    removePushSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

interface BrowserSetup {
  permission?: NotificationPermission;
  requestPermission?: Mock;
  secure?: boolean;
  subscription?: SubscriptionMock | null;
  stored?: string | null;
  setItemFailure?: Error | null;
}

function setupBrowser({
  permission = "granted",
  requestPermission = vi.fn().mockResolvedValue("granted"),
  secure = true,
  subscription = null,
  stored = null,
  setItemFailure = null,
}: BrowserSetup = {}) {
  let storage = stored;
  const subscribed = subscriptionMock();
  const getSubscription = vi.fn().mockResolvedValue(subscription);
  const subscribe = vi.fn().mockResolvedValue(subscribed);
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const pushManager = { getSubscription, subscribe };
  const registration = { pushManager, showNotification } as unknown as ServiceWorkerRegistration;
  const notification = { permission, requestPermission } as unknown as typeof Notification;
  const localStorage = {
    getItem: vi.fn(() => storage),
    setItem: vi.fn((_key: string, value: string) => {
      if (setItemFailure) throw setItemFailure;
      storage = value;
    }),
  };
  vi.stubGlobal("window", {
    isSecureContext: secure,
    Notification: notification,
    PushManager: class PushManagerMock {},
    crypto: { randomUUID: () => "device-generated" },
    localStorage,
  });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve(registration) } });
  vi.stubGlobal("crypto", { randomUUID: () => "device-generated" });
  return {
    getStored: () => storage,
    getSubscription,
    localStorage,
    registration,
    requestPermission,
    showNotification,
    subscribe,
    subscribed,
  };
}

function storedRegistration(events = { inputRequired: true, sessionIdle: false }): string {
  return JSON.stringify({
    version: NOTIFICATION_PREFERENCES_VERSION,
    deviceId: "device-existing",
    vapidPublicKey: PUBLIC_KEY,
    events,
  });
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Push support and per-device storage", () => {
  it("requires a secure context, Notifications, service workers, and PushManager", () => {
    setupBrowser({ secure: false });
    expect(isPushNotificationSupported()).toBe(false);
    setupBrowser();
    expect(isPushNotificationSupported()).toBe(true);
  });

  it("keeps preference-only version 1 records off until this device is explicitly re-enabled", () => {
    setupBrowser({
      stored: JSON.stringify({
        version: 1,
        events: { inputRequired: true, sessionIdle: true },
      }),
    });
    expect(readNotificationPreferences()).toBeNull();
  });

  it("persists only the current typed event preferences with its device and VAPID identity", () => {
    const browser = setupBrowser();
    expect(
      writeNotificationRegistration({
        version: NOTIFICATION_PREFERENCES_VERSION,
        deviceId: "device-1",
        vapidPublicKey: PUBLIC_KEY,
        events: { inputRequired: true, sessionIdle: false },
      }),
    ).toBe(true);
    expect(readNotificationPreferences()).toEqual({ inputRequired: true, sessionIdle: false });
    expect(JSON.parse(browser.getStored() ?? "null")).toEqual({
      version: 2,
      deviceId: "device-1",
      vapidPublicKey: PUBLIC_KEY,
      events: { inputRequired: true, sessionIdle: false },
    });
    expect(browser.localStorage.setItem).toHaveBeenCalledWith(
      NOTIFICATION_PREFERENCES_STORAGE_KEY,
      expect.any(String),
    );
  });

  it("converts the daemon base64url key to the exact 65-byte application server key", () => {
    const bytes = vapidPublicKeyBytes(PUBLIC_KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(65);
    expect(() => vapidPublicKeyBytes("too-short")).toThrow("invalid push public key");
  });
});

describe("explicit Push lifecycle", () => {
  it("reports unsupported and denied states without requesting or subscribing", async () => {
    const unsupportedBrowser = setupBrowser({ secure: false });
    const unsupportedClient = clientMock();
    await expect(changePushPreference(unsupportedClient, "inputRequired", true)).resolves.toMatchObject({
      state: "unsupported",
      preferences: { inputRequired: false, sessionIdle: false },
    });
    expect(unsupportedBrowser.subscribe).not.toHaveBeenCalled();

    setupBrowser({ permission: "denied" });
    const deniedClient = clientMock();
    await expect(changePushPreference(deniedClient, "inputRequired", true)).resolves.toMatchObject({
      state: "blocked",
      preferences: { inputRequired: false, sessionIdle: false },
    });
    expect(deniedClient.pushVapidPublicKey).not.toHaveBeenCalled();
  });

  it("requests permission, waits for the ready worker, subscribes, and registers only the selected event", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const browser = setupBrowser({ permission: "default", requestPermission });
    const client = clientMock();

    const result = await changePushPreference(client, "sessionIdle", true);

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(client.pushVapidPublicKey).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(client.registerPushSubscription).toHaveBeenCalledWith({
      deviceId: "device-generated",
      subscription: SUBSCRIPTION_JSON,
      events: { inputRequired: false, sessionIdle: true },
    });
    expect(result).toEqual({
      state: "enabled",
      preferences: { inputRequired: false, sessionIdle: true },
      error: null,
    });
  });

  it("updates independent preferences without creating a second browser subscription", async () => {
    const subscription = subscriptionMock();
    const browser = setupBrowser({ subscription, stored: storedRegistration() });
    const client = clientMock();

    const result = await changePushPreference(client, "sessionIdle", true);

    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
    expect(client.updatePushSubscription).toHaveBeenCalledWith({
      deviceId: "device-existing",
      subscription: SUBSCRIPTION_JSON,
      events: { inputRequired: true, sessionIdle: true },
    });
    expect(result.preferences).toEqual({ inputRequired: true, sessionIdle: true });
  });

  it("updates the daemon when one event remains, then removes and unsubscribes only this device", async () => {
    const subscription = subscriptionMock();
    setupBrowser({
      subscription,
      stored: storedRegistration({ inputRequired: true, sessionIdle: true }),
    });
    const client = clientMock();

    const oneRemaining = await changePushPreference(client, "inputRequired", false);
    expect(client.updatePushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ events: { inputRequired: false, sessionIdle: true } }),
    );
    expect(client.removePushSubscription).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(oneRemaining.state).toBe("enabled");

    const disabled = await changePushPreference(client, "sessionIdle", false);
    expect(client.removePushSubscription).toHaveBeenCalledWith({ deviceId: "device-existing" });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(disabled).toEqual({
      state: "prompt",
      preferences: { inputRequired: false, sessionIdle: false },
      error: null,
    });
  });

  it("preserves the remaining fallback preference when a partial disable finds no subscription", async () => {
    setupBrowser({
      stored: storedRegistration({ inputRequired: true, sessionIdle: true }),
    });
    const client = clientMock();

    const result = await changePushPreference(client, "inputRequired", false);

    expect(client.removePushSubscription).toHaveBeenCalledWith({ deviceId: "device-existing" });
    expect(result).toEqual({
      state: "prompt",
      preferences: { inputRequired: false, sessionIdle: true },
      error: null,
    });
    expect(readNotificationPreferences()).toEqual({ inputRequired: false, sessionIdle: true });
  });

  it("shows a bounded error and never reports enabled when daemon registration fails", async () => {
    const browser = setupBrowser();
    const client = clientMock();
    client.registerPushSubscription.mockRejectedValue(new Error(`host refused ${"x".repeat(700)}`));

    const result = await changePushPreference(client, "inputRequired", true);

    expect(result.state).toBe("error");
    expect(result.preferences).toEqual({ inputRequired: false, sessionIdle: false });
    expect(result.error).toHaveLength(500);
    expect(browser.subscribed.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.getStored()).toBeNull();
  });

  it("cleans up a newly registered subscription when local persistence fails", async () => {
    const browser = setupBrowser({ setItemFailure: new Error("storage unavailable") });
    const client = clientMock();

    const result = await changePushPreference(client, "inputRequired", true);

    expect(result.state).toBe("error");
    expect(client.registerPushSubscription).toHaveBeenCalledOnce();
    expect(client.removePushSubscription).toHaveBeenCalledWith({ deviceId: "device-generated" });
    expect(browser.subscribed.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.getStored()).toBeNull();
  });

  it("rolls an existing daemon update back when local persistence fails", async () => {
    const subscription = subscriptionMock();
    setupBrowser({
      subscription,
      stored: storedRegistration(),
      setItemFailure: new Error("storage unavailable"),
    });
    const client = clientMock();

    const result = await changePushPreference(client, "sessionIdle", true);

    expect(result.state).toBe("error");
    expect(client.updatePushSubscription.mock.calls.map(([update]) => update.events)).toEqual([
      { inputRequired: true, sessionIdle: true },
      { inputRequired: true, sessionIdle: false },
    ]);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("rolls a partial disable back and reports rollback failure when compensation fails", async () => {
    const subscription = subscriptionMock();
    setupBrowser({
      subscription,
      stored: storedRegistration({ inputRequired: true, sessionIdle: true }),
      setItemFailure: new Error("storage unavailable"),
    });
    const client = clientMock();
    client.updatePushSubscription
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("rollback unavailable"));

    const result = await changePushPreference(client, "inputRequired", false);

    expect(result.state).toBe("error");
    expect(result.error).toContain("Host rollback failed: rollback unavailable");
    expect(client.updatePushSubscription.mock.calls.map(([update]) => update.events)).toEqual([
      { inputRequired: false, sessionIdle: true },
      { inputRequired: true, sessionIdle: true },
    ]);
  });
});

describe("notification operation serialization", () => {
  it("serializes rapid independent toggles and commits snapshots in operation order", async () => {
    const subscription = subscriptionMock();
    setupBrowser({
      subscription,
      stored: storedRegistration({ inputRequired: false, sessionIdle: false }),
    });
    const client = clientMock();
    const firstUpdate = deferredPromise<void>();
    client.updatePushSubscription.mockImplementationOnce(() => firstUpdate.promise);
    const queue = createNotificationOperationQueue();
    const commits: Array<{ inputRequired: boolean; sessionIdle: boolean }> = [];

    const first = queue.run(
      () => changePushPreference(client, "inputRequired", true),
      (snapshot) => commits.push(snapshot.preferences),
    );
    const second = queue.run(
      () => changePushPreference(client, "sessionIdle", true),
      (snapshot) => commits.push(snapshot.preferences),
    );

    await vi.waitFor(() => expect(client.updatePushSubscription).toHaveBeenCalledTimes(1));
    expect(client.updatePushSubscription.mock.calls[0]?.[0].events).toEqual({
      inputRequired: true,
      sessionIdle: false,
    });
    firstUpdate.resolve(undefined);
    await Promise.all([first, second]);

    expect(client.updatePushSubscription.mock.calls.map(([update]) => update.events)).toEqual([
      { inputRequired: true, sessionIdle: false },
      { inputRequired: true, sessionIdle: true },
    ]);
    expect(commits).toEqual([
      { inputRequired: true, sessionIdle: false },
      { inputRequired: true, sessionIdle: true },
    ]);
  });

  it("queues a toggle behind in-flight reconciliation", async () => {
    const subscription = subscriptionMock();
    setupBrowser({ subscription, stored: storedRegistration() });
    const client = clientMock();
    const registration = deferredPromise<void>();
    client.registerPushSubscription.mockImplementationOnce(() => registration.promise);
    const queue = createNotificationOperationQueue();
    const commits: Array<{ inputRequired: boolean; sessionIdle: boolean }> = [];

    const reconcile = queue.run(
      () => reconcilePushNotifications(client),
      (snapshot) => commits.push(snapshot.preferences),
    );
    const toggle = queue.run(
      () => changePushPreference(client, "sessionIdle", true),
      (snapshot) => commits.push(snapshot.preferences),
    );

    await vi.waitFor(() => expect(client.registerPushSubscription).toHaveBeenCalledOnce());
    expect(client.updatePushSubscription).not.toHaveBeenCalled();
    registration.resolve(undefined);
    await Promise.all([reconcile, toggle]);

    expect(client.updatePushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ events: { inputRequired: true, sessionIdle: true } }),
    );
    expect(commits).toEqual([
      { inputRequired: true, sessionIdle: false },
      { inputRequired: true, sessionIdle: true },
    ]);
  });

  it("continues with the next operation after a failure", async () => {
    const queue = createNotificationOperationQueue();
    const commit = vi.fn();
    const failed = queue.run(() => Promise.reject(new Error("failed operation")), commit);
    const nextSnapshot = {
      state: "prompt",
      preferences: { inputRequired: false, sessionIdle: false },
      error: null,
    } as const;
    const next = queue.run(() => Promise.resolve(nextSnapshot), commit);

    await expect(failed).rejects.toThrow("failed operation");
    await expect(next).resolves.toEqual(nextSnapshot);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(nextSnapshot);
  });
});

describe("reload reconciliation", () => {
  it("re-registers an existing local subscription without silently subscribing", async () => {
    const subscription = subscriptionMock();
    const browser = setupBrowser({ subscription, stored: storedRegistration() });
    const client = clientMock();

    const result = await reconcilePushNotifications(client);

    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(client.registerPushSubscription).toHaveBeenCalledWith({
      deviceId: "device-existing",
      subscription: SUBSCRIPTION_JSON,
      events: { inputRequired: true, sessionIdle: false },
    });
    expect(result.state).toBe("enabled");
  });

  it("does not create or register a subscription when local state is missing", async () => {
    const browser = setupBrowser();
    const client = clientMock();

    const result = await reconcilePushNotifications(client);

    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "prompt",
      preferences: { inputRequired: false, sessionIdle: false },
      error: null,
    });
  });

  it("preserves opted-in fallback after removing stale daemon state for a missing subscription", async () => {
    const browser = setupBrowser({ stored: storedRegistration() });
    const client = clientMock();

    const result = await reconcilePushNotifications(client);
    const delivery = await deliverForegroundNotification(NOTIFICATION, result.preferences);

    expect(client.removePushSubscription).toHaveBeenCalledWith({ deviceId: "device-existing" });
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "prompt",
      preferences: { inputRequired: true, sessionIdle: false },
      error: null,
    });
    expect(readNotificationPreferences()).toEqual({ inputRequired: true, sessionIdle: false });
    expect(delivery).toBe("shown");
    expect(browser.showNotification).toHaveBeenCalledOnce();
  });

  it("cleans up a known device when notification permission resets", async () => {
    const subscription = subscriptionMock();
    setupBrowser({ permission: "default", subscription, stored: storedRegistration() });
    const client = clientMock();

    const result = await reconcilePushNotifications(client);

    expect(client.removePushSubscription).toHaveBeenCalledWith({ deviceId: "device-existing" });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "prompt",
      preferences: { inputRequired: true, sessionIdle: false },
      error: null,
    });
  });

  it("unsubscribes an orphan subscription when its local record is invalid", async () => {
    const subscription = subscriptionMock();
    setupBrowser({
      subscription,
      stored: JSON.stringify({
        version: 1,
        events: { inputRequired: true, sessionIdle: true },
      }),
    });
    const client = clientMock();

    const result = await reconcilePushNotifications(client);

    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(client.removePushSubscription).not.toHaveBeenCalled();
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "prompt",
      preferences: { inputRequired: false, sessionIdle: false },
      error: null,
    });
  });

  it("removes an all-events-off subscription instead of reporting enabled", async () => {
    const subscription = subscriptionMock();
    setupBrowser({
      subscription,
      stored: storedRegistration({ inputRequired: false, sessionIdle: false }),
    });
    const client = clientMock();

    const result = await reconcilePushNotifications(client);

    expect(client.removePushSubscription).toHaveBeenCalledWith({ deviceId: "device-existing" });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
    expect(result.state).toBe("prompt");
  });

  it("surfaces unsubscribe false as cleanup failure", async () => {
    const subscription = subscriptionMock();
    subscription.unsubscribe.mockResolvedValue(false);
    setupBrowser({
      subscription,
      stored: storedRegistration({ inputRequired: false, sessionIdle: false }),
    });
    const client = clientMock();

    const result = await reconcilePushNotifications(client);

    expect(result.state).toBe("error");
    expect(result.error).toContain("did not remove its push subscription");
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("waits for the session transport to connect before reconciling with the daemon", async () => {
    const subscription = subscriptionMock();
    setupBrowser({ subscription, stored: storedRegistration() });
    const client = clientMock();
    client.connection = "connecting";

    const result = await reconcilePushNotifications(client);

    expect(result.state).toBe("prompt");
    expect(client.pushVapidPublicKey).not.toHaveBeenCalled();
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("requires an explicit re-enable when the daemon VAPID key changed", async () => {
    const subscription = subscriptionMock();
    setupBrowser({ subscription, stored: storedRegistration() });
    const client = clientMock();
    client.pushVapidPublicKey.mockResolvedValue(`A${PUBLIC_KEY.slice(1)}`);

    const result = await reconcilePushNotifications(client);

    expect(result.state).toBe("error");
    expect(result.error).toContain("push key changed");
    expect(client.registerPushSubscription).not.toHaveBeenCalled();
  });
});

describe("daemon-authored foreground fallback", () => {
  it("shows one stable notification with the same-origin session path when Push is inactive", async () => {
    const browser = setupBrowser();

    const result = await deliverForegroundNotification(NOTIFICATION, {
      inputRequired: true,
      sessionIdle: false,
    });

    expect(result).toBe("shown");
    expect(browser.showNotification).toHaveBeenCalledOnce();
    expect(browser.showNotification).toHaveBeenCalledWith("Input required", {
      ...SESSION_NOTIFICATION_OPTIONS,
      body: "Build is waiting for input.",
      tag: "session-session-1-ask-1",
      data: { url: "/?session=session-1" },
    });
  });

  it("does not duplicate a daemon event when this browser already has an active Push subscription", async () => {
    const browser = setupBrowser({ subscription: subscriptionMock() });

    const result = await deliverForegroundNotification(NOTIFICATION, {
      inputRequired: true,
      sessionIdle: true,
    });

    expect(result).toBe("push-active");
    expect(browser.showNotification).not.toHaveBeenCalled();
  });

  it("ignores an event whose independent preference is off", async () => {
    const browser = setupBrowser();
    await expect(
      deliverForegroundNotification(NOTIFICATION, { inputRequired: false, sessionIdle: true }),
    ).resolves.toBe("ignored");
    expect(browser.getSubscription).not.toHaveBeenCalled();
    expect(browser.showNotification).not.toHaveBeenCalled();
  });
});
