import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import type { Mock } from "vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";

interface WindowClientMock {
  url: string;
  navigate: Mock;
  focus: Mock;
}

interface NotificationClickInput {
  data?: unknown;
  windowClients?: WindowClientMock[];
}

let serviceWorkerSource = "";

beforeAll(async () => {
  serviceWorkerSource = await readFile(new URL("../public/notification-sw.js", import.meta.url), "utf8");
});

async function executeNotificationClick({ data, windowClients = [] }: NotificationClickInput) {
  let clickHandler:
    | ((event: {
        notification: { close(): void; data?: unknown };
        waitUntil(promise: Promise<void>): void;
      }) => void)
    | undefined;
  let completion: Promise<void> | undefined;
  const close = vi.fn();
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(windowClients);
  const self = {
    location: { origin: "https://app.test" },
    clients: { matchAll, openWindow },
    addEventListener: vi.fn((type: string, handler: typeof clickHandler) => {
      if (type === "notificationclick") clickHandler = handler;
    }),
  };

  runInNewContext(serviceWorkerSource, { self, URL });
  if (!clickHandler) throw new Error("service worker did not register notificationclick");

  clickHandler({
    notification: { close, data },
    waitUntil(promise) {
      completion = promise;
    },
  });
  if (!completion) throw new Error("notification click did not call waitUntil");
  await completion;

  return { close, matchAll, openWindow };
}

describe("notification service worker click navigation", () => {
  it("navigates the first same-origin client to the target before focusing it", async () => {
    const calls: string[] = [];
    const crossOriginClient: WindowClientMock = {
      url: "https://other.test/",
      navigate: vi.fn(),
      focus: vi.fn(),
    };
    const appClient: WindowClientMock = {
      url: "https://app.test/current",
      navigate: vi.fn(async (url: string) => {
        calls.push(`navigate:${url}`);
      }),
      focus: vi.fn(async () => {
        calls.push("focus");
      }),
    };

    const result = await executeNotificationClick({
      data: { url: "/?session=session-2" },
      windowClients: [crossOriginClient, appClient],
    });

    expect(result.close).toHaveBeenCalledOnce();
    expect(result.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(appClient.navigate).toHaveBeenCalledWith("/?session=session-2");
    expect(appClient.focus).toHaveBeenCalledOnce();
    expect(calls).toEqual(["navigate:/?session=session-2", "focus"]);
    expect(crossOriginClient.navigate).not.toHaveBeenCalled();
    expect(crossOriginClient.focus).not.toHaveBeenCalled();
    expect(result.openWindow).not.toHaveBeenCalled();
  });

  it("opens the target when the app has no open window", async () => {
    const result = await executeNotificationClick({ data: { url: "/?session=session-2" } });

    expect(result.openWindow).toHaveBeenCalledOnce();
    expect(result.openWindow).toHaveBeenCalledWith("/?session=session-2");
  });

  it.each([
    ["missing data", undefined],
    ["missing URL", {}],
    ["malformed URL", { url: "http://[broken" }],
    ["cross-origin URL", { url: "https://attacker.test/?session=stolen" }],
  ])("falls back to the app root for %s", async (_case, data) => {
    const result = await executeNotificationClick({ data });

    expect(result.openWindow).toHaveBeenCalledOnce();
    expect(result.openWindow).toHaveBeenCalledWith("/");
  });
});
