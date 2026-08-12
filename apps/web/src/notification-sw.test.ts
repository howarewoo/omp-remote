import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import type { Mock } from "vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";

interface WindowClientMock {
  url: string;
  navigate: Mock;
  focus: Mock;
}

let serviceWorkerSource = "";

beforeAll(async () => {
  serviceWorkerSource = await readFile(new URL("../public/notification-sw.js", import.meta.url), "utf8");
});

function serviceWorkerHarness(windowClients: WindowClientMock[] = []) {
  let pushHandler:
    | ((event: { data?: { json(): unknown }; waitUntil(promise: Promise<void>): void }) => void)
    | undefined;
  let clickHandler:
    | ((event: {
        notification: { close(): void; data?: unknown };
        waitUntil(promise: Promise<void>): void;
      }) => void)
    | undefined;
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(windowClients);
  const self = {
    location: { origin: "https://app.test" },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: vi.fn((type: string, handler: typeof pushHandler | typeof clickHandler) => {
      if (type === "push") pushHandler = handler as typeof pushHandler;
      if (type === "notificationclick") clickHandler = handler as typeof clickHandler;
    }),
  };
  runInNewContext(serviceWorkerSource, { self, URL });
  if (!pushHandler || !clickHandler) throw new Error("service worker did not register expected handlers");

  return {
    async push(value: unknown, throws = false) {
      let completion: Promise<void> | undefined;
      pushHandler?.({
        data: {
          json() {
            if (throws) throw new Error("malformed JSON");
            return value;
          },
        },
        waitUntil(promise) {
          completion = promise;
        },
      });
      if (!completion) throw new Error("push handler did not call waitUntil");
      await completion;
    },
    async click(data?: unknown) {
      let completion: Promise<void> | undefined;
      const close = vi.fn();
      clickHandler?.({
        notification: { close, data },
        waitUntil(promise) {
          completion = promise;
        },
      });
      if (!completion) throw new Error("notification click did not call waitUntil");
      await completion;
      return { close };
    },
    matchAll,
    openWindow,
    showNotification,
  };
}

const VALID_EVENT = {
  type: "notification_event",
  event: "inputRequired",
  title: "Input required",
  body: "Build is waiting for input.",
  tag: "session-session-1-ask-1",
  url: "/?session=session-1",
};

describe("notification service worker push", () => {
  it("validates and displays the daemon payload inside waitUntil with stable options", async () => {
    const worker = serviceWorkerHarness();

    await worker.push(VALID_EVENT);

    expect(worker.showNotification).toHaveBeenCalledOnce();
    expect(worker.showNotification).toHaveBeenCalledWith("Input required", {
      body: "Build is waiting for input.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "session-session-1-ask-1",
      data: { url: "/?session=session-1" },
    });
  });

  it.each([
    ["missing payload", undefined, false],
    ["invalid JSON", undefined, true],
    ["unknown field", { ...VALID_EVENT, privateData: "leak" }, false],
    ["mismatched title", { ...VALID_EVENT, title: "Session idle" }, false],
    ["unknown event", { ...VALID_EVENT, event: "finished" }, false],
    ["empty body", { ...VALID_EVENT, body: " " }, false],
    ["oversized body", { ...VALID_EVENT, body: "x".repeat(1001) }, false],
    ["oversized tag", { ...VALID_EVENT, tag: "x".repeat(257) }, false],
    ["cross-origin URL", { ...VALID_EVENT, url: "https://attacker.test/" }, false],
    ["protocol-relative URL", { ...VALID_EVENT, url: "//attacker.test/" }, false],
  ])("safely ignores %s without rejecting waitUntil", async (_name, payload, throws) => {
    const worker = serviceWorkerHarness();

    await expect(worker.push(payload, throws)).resolves.toBeUndefined();
    expect(worker.showNotification).not.toHaveBeenCalled();
  });
});

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
    const worker = serviceWorkerHarness([crossOriginClient, appClient]);

    const result = await worker.click({ url: "/?session=session-2" });

    expect(result.close).toHaveBeenCalledOnce();
    expect(worker.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(appClient.navigate).toHaveBeenCalledWith("/?session=session-2");
    expect(appClient.focus).toHaveBeenCalledOnce();
    expect(calls).toEqual(["navigate:/?session=session-2", "focus"]);
    expect(crossOriginClient.navigate).not.toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it("opens the normalized path from a same-origin absolute target when the app has no open window", async () => {
    const worker = serviceWorkerHarness();
    await worker.click({ url: "https://app.test/?session=session-2" });
    expect(worker.openWindow).toHaveBeenCalledWith("/?session=session-2");
  });

  it.each([
    ["missing data", undefined],
    ["missing URL", {}],
    ["malformed URL", { url: "http://[broken" }],
    ["cross-origin URL", { url: "https://attacker.test/?session=stolen" }],
    ["protocol-relative URL", { url: "//attacker.test/?session=stolen" }],
  ])("falls back to the app root for %s", async (_case, data) => {
    const worker = serviceWorkerHarness();
    await worker.click(data);
    expect(worker.openWindow).toHaveBeenCalledWith("/");
  });
});
