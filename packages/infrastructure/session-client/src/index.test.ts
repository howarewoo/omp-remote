import type { NotificationEvent, Session, SessionTranscriptResponse } from "@omp-remote/protocol";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  applyTranscriptToSessions,
  boundedServerError,
  commandResultValue,
  cleanupSessionHistory,
  createCatalogLoadCoordinator,
  dispatchNotificationEvent,
  mergeSessions,
  mergeTranscriptMessages,
  type QueuedUserMessage,
  rejectPendingCommands,
  resolvePendingCommand,
  sendBrowserCommand,
  SESSION_COMMAND_TIMEOUT_MS,
  snapshotSessionsWithCurrentMessages,
  type TranscriptProvenance,
  upsertTranscriptMessage,
  useSessionClient,
} from "./index.js";

const hookHarness = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  stateSetters: [] as Mock[],
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => undefined | (() => void)) => {
    hookHarness.effects.push(effect);
  },
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(initialValue: T) => ({ current: initialValue }),
  useState: <T>(initialValue: T) => {
    const setter = vi.fn();
    hookHarness.stateSetters.push(setter);
    return [initialValue, setter] as const;
  },
}));

const SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Stream test",
  cwd: "/tmp/stream-test",
  branch: "feature/streaming",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-28T21:00:00.000Z",
  lastActivity: "2026-07-28T22:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [
    {
      id: "message-1",
      role: "assistant",
      text: "Starting",
      timestamp: "2026-07-28T22:01:00.000Z",
      streaming: true,
      presentation: "text",
    },
  ],
  sessionPath: "/tmp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};
const makeMsg = (id: string, text = id, streaming = false): Session["messages"][number] => ({
  id,
  role: "user",
  text,
  timestamp: "2026-08-01T00:00:00.000Z",
  streaming,
  presentation: "text",
});
const makePage = (
  sessionId: string,
  messages: Session["messages"] = [],
  status: "available" | "complete" | "unavailable" | "invalidated" = "complete",
  olderCursor: string | null = null,
): SessionTranscriptResponse =>
  (status === "available"
    ? { sessionId, messages, status: "available", olderCursor: olderCursor ?? "cursor" }
    : { sessionId, messages, status, olderCursor: null }) as SessionTranscriptResponse;

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  });

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(frame: unknown): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", {
      value: typeof frame === "string" ? frame : JSON.stringify(frame),
    });
    this.dispatchEvent(event);
  }
}

class FakeBrowserTarget extends EventTarget {
  readonly location = { protocol: "http:", host: "localhost:4387" };
  visibilityState: DocumentVisibilityState = "visible";
  readonly setTimeout = (callback: TimerHandler, timeout?: number) =>
    globalThis.setTimeout(callback, timeout) as unknown as number;
  readonly clearTimeout = (timer: number) => globalThis.clearTimeout(timer);
}

const SNAPSHOT_FRAME = {
  type: "snapshot",
  sessions: [],
  askRequests: [],
  savedWorkingDirectories: [],
} as const;

describe("queued follow-up commands", () => {
  beforeEach(() => {
    hookHarness.effects.length = 0;
    hookHarness.stateSetters.length = 0;
  });

  it("stores follow-ups locally and lets the user remove them before dispatch", async () => {
    const client = useSessionClient();
    const queuedMessagesSetter = hookHarness.stateSetters[13];
    if (!queuedMessagesSetter) throw new Error("Expected queued message state");

    await client.command("session-1", "follow_up", "Run this next");
    const enqueue = queuedMessagesSetter.mock.calls[0]?.[0] as
      | ((messages: QueuedUserMessage[]) => QueuedUserMessage[])
      | undefined;
    if (!enqueue) throw new Error("Expected queued message updater");
    const queued = enqueue([]);

    expect(queued).toMatchObject([
      {
        sessionId: "session-1",
        text: "Run this next",
        status: "queued",
      },
    ]);

    client.cancelQueuedMessage(queued[0]?.id ?? "");
    const remove = queuedMessagesSetter.mock.calls[1]?.[0] as
      | ((messages: QueuedUserMessage[]) => QueuedUserMessage[])
      | undefined;
    expect(remove?.(queued)).toEqual([]);
  });
});

describe("session WebSocket lifecycle", () => {
  let browserTarget: FakeBrowserTarget;
  let documentTarget: FakeBrowserTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    hookHarness.effects.length = 0;
    hookHarness.stateSetters.length = 0;
    FakeWebSocket.instances = [];
    browserTarget = new FakeBrowserTarget();
    documentTarget = new FakeBrowserTarget();
    vi.stubGlobal("window", browserTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays connecting and starts the ten-second snapshot deadline only after open", () => {
    useSessionClient();
    const cleanup = hookHarness.effects[0]?.();
    const socket = FakeWebSocket.instances[0];
    const connectionSetter = hookHarness.stateSetters[10];
    if (!socket || !connectionSetter) throw new Error("Expected the connection effect to create a socket");

    vi.advanceTimersByTime(10_000);
    expect(socket.close).not.toHaveBeenCalled();
    socket.open();
    expect(connectionSetter).not.toHaveBeenCalledWith("connected");
    vi.advanceTimersByTime(9_999);
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(connectionSetter).toHaveBeenLastCalledWith("disconnected");
    cleanup?.();
  });

  it("coalesces recovery, rejects pending work, ignores stale callbacks, and cleans up", async () => {
    const client = useSessionClient();
    const cleanup = hookHarness.effects[0]?.();
    const firstSocket = FakeWebSocket.instances[0];
    const connectionSetter = hookHarness.stateSetters[10];
    if (!firstSocket || !connectionSetter)
      throw new Error("Expected the connection effect to create a socket");

    firstSocket.open();
    firstSocket.message(SNAPSHOT_FRAME);
    const pendingCommand = client.command("session-1", "prompt", "continue");
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    browserTarget.dispatchEvent(new Event("pageshow"));
    browserTarget.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
    await expect(pendingCommand).rejects.toThrow("Dashboard disconnected");

    const connectedCalls = connectionSetter.mock.calls.filter(([state]) => state === "connected").length;
    firstSocket.message(SNAPSHOT_FRAME);
    expect(connectionSetter.mock.calls.filter(([state]) => state === "connected")).toHaveLength(
      connectedCalls,
    );
    const replacementSocket = FakeWebSocket.instances[1];
    if (!replacementSocket) throw new Error("Expected one replacement socket");
    browserTarget.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
    replacementSocket.open();
    replacementSocket.message(SNAPSHOT_FRAME);
    replacementSocket.message("{");
    expect(replacementSocket.close).toHaveBeenCalledOnce();

    cleanup?.();
    browserTarget.dispatchEvent(new Event("pageshow"));
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const callsAfterCleanup = connectionSetter.mock.calls.length;
    const strictModeCleanup = hookHarness.effects[0]?.();
    firstSocket.dispatchEvent(new Event("error"));
    firstSocket.message(SNAPSHOT_FRAME);
    expect(connectionSetter).toHaveBeenCalledTimes(callsAfterCleanup + 1);
    strictModeCleanup?.();
  });
});

describe("commandResultValue", () => {
  it("returns only the response shape correlated to the request command", () => {
    expect(commandResultValue("launch", { type: "launch", sessionId: "created-session" })).toEqual({
      type: "launch",
      sessionId: "created-session",
    });
    expect(
      commandResultValue("push_vapid_public_key", {
        type: "push_vapid_public_key",
        publicKey: "BOrK6yGWP_i0T7XjsNwdpM5g2-OC-F2sJBuCMH9SF2kb8qRfdHVZb-tPPOXQqvI8LNkoHqO5sP8rv7glORQUsLs",
      }),
    ).toMatchObject({ type: "push_vapid_public_key" });
    expect(commandResultValue("push_subscription_register", { type: "void" })).toEqual({
      type: "void",
    });
  });

  it("rejects a result belonging to a different command kind", () => {
    expect(() => commandResultValue("launch", { type: "void" })).toThrow(
      "The host did not identify the launched session",
    );
    expect(() =>
      commandResultValue("push_subscription_update", {
        type: "launch",
        sessionId: "wrong-session",
      }),
    ).toThrow("The host returned a result for a different command");
    expect(() => commandResultValue("push_vapid_public_key", { type: "void" })).toThrow(
      "The host did not return its push public key",
    );
  });
});

describe("sendBrowserCommand", () => {
  it("sends the exact switch frame and clears the pending request on timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const pendingCommands = new Map();
      const frame = {
        type: "switch_branch" as const,
        requestId: "request-1",
        sessionId: "session-1",
        branch: "feature/sibling",
      };

      const result = sendBrowserCommand(socket, pendingCommands, frame, 1_000);
      const rejection = expect(result).rejects.toThrow(
        "The host did not respond before the command timed out",
      );

      expect(socket.send).toHaveBeenCalledWith(JSON.stringify(frame));
      expect(pendingCommands.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(pendingCommands.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("sends the exact launch frame with 20-second timeout and clears pending request on timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const pendingCommands = new Map();
      const frame = {
        type: "launch" as const,
        requestId: "launch-req-1",
        cwd: "/work/project",
        resume: null,
      };

      const result = sendBrowserCommand(socket, pendingCommands, frame, 20_000);
      const rejection = expect(result).rejects.toThrow(
        "The host did not respond before the command timed out",
      );

      expect(socket.send).toHaveBeenCalledWith(JSON.stringify(frame));
      expect(pendingCommands.size).toBe(1);
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
      expect(pendingCommands.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up pending launch command and timeout on correlated success", async () => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const pendingCommands = new Map();
      const frame = {
        type: "launch" as const,
        requestId: "launch-req-2",
        cwd: "/work/project",
        resume: "prior-session-id",
      };

      const result = sendBrowserCommand(socket, pendingCommands, frame, 20_000);
      expect(pendingCommands.size).toBe(1);

      const resolved = resolvePendingCommand(pendingCommands, {
        type: "command_result",
        requestId: "launch-req-2",
        outcome: {
          status: "ok",
          value: { type: "launch", sessionId: "resumed-session-id" },
        },
      });

      expect(resolved).toBe(true);
      await expect(result).resolves.toEqual({
        type: "launch",
        sessionId: "resumed-session-id",
      });
      expect(pendingCommands.size).toBe(0);

      // Advance timers past 20s to ensure timeout callback does not fire
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "prompt",
      frame: {
        type: "session_command" as const,
        requestId: "req-prompt",
        sessionId: "session-1",
        command: "prompt" as const,
        text: "execute step",
      },
    },
    {
      name: "steer",
      frame: {
        type: "session_command" as const,
        requestId: "req-steer",
        sessionId: "session-1",
        command: "steer" as const,
        text: "execute step",
      },
    },
    {
      name: "abort",
      frame: {
        type: "session_command" as const,
        requestId: "req-abort",
        sessionId: "session-1",
        command: "abort" as const,
      },
    },
    {
      name: "kill",
      frame: {
        type: "session_command" as const,
        requestId: "req-kill",
        sessionId: "session-1",
        command: "kill" as const,
      },
    },
  ])("clears pending $name session command on 20-second timeout", async ({ frame }) => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const pendingCommands = new Map();

      const result = sendBrowserCommand(socket, pendingCommands, frame, SESSION_COMMAND_TIMEOUT_MS);
      const rejection = expect(result).rejects.toThrow(
        "The host did not respond before the command timed out",
      );

      expect(socket.send).toHaveBeenCalledWith(JSON.stringify(frame));
      expect(pendingCommands.size).toBe(1);
      await vi.advanceTimersByTimeAsync(SESSION_COMMAND_TIMEOUT_MS);
      await rejection;
      expect(pendingCommands.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels session command timeout on correlated success", async () => {
    vi.useFakeTimers();
    try {
      const socket = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      } as unknown as WebSocket;
      const pendingCommands = new Map();
      const frame = {
        type: "session_command" as const,
        requestId: "req-prompt-success",
        sessionId: "session-1",
        command: "prompt" as const,
        text: "do work",
      };

      const result = sendBrowserCommand(socket, pendingCommands, frame, SESSION_COMMAND_TIMEOUT_MS);
      expect(pendingCommands.size).toBe(1);

      const resolved = resolvePendingCommand(pendingCommands, {
        type: "command_result",
        requestId: "req-prompt-success",
        outcome: {
          status: "ok",
          value: { type: "void" },
        },
      });

      expect(resolved).toBe(true);
      await expect(result).resolves.toEqual({ type: "void" });
      expect(pendingCommands.size).toBe(0);

      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("push browser commands", () => {
  it("sends and resolves each correlated push transport command", async () => {
    const send = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;
    const pendingCommands = new Map();
    const subscription = {
      endpoint: "https://push.example/subscription",
      keys: {
        p256dh: "BOrK6yGWP_i0T7XjsNwdpM5g2-OC-F2sJBuCMH9SF2kb8qRfdHVZb-tPPOXQqvI8LNkoHqO5sP8rv7glORQUsLs",
        auth: "AQIDBAUGBwgJCgsMDQ4PEA",
      },
    };
    const frames = [
      { type: "push_vapid_public_key", requestId: "push-key" },
      {
        type: "push_subscription_register",
        requestId: "push-register",
        deviceId: "device-1",
        subscription,
        events: { inputRequired: true, sessionIdle: false },
      },
      {
        type: "push_subscription_update",
        requestId: "push-update",
        deviceId: "device-1",
        subscription,
        events: { inputRequired: false, sessionIdle: true },
      },
      { type: "push_subscription_remove", requestId: "push-remove", deviceId: "device-1" },
    ] as const;
    const results = frames.map((frame) => sendBrowserCommand(socket, pendingCommands, frame));

    resolvePendingCommand(pendingCommands, {
      type: "command_result",
      requestId: "push-key",
      outcome: {
        status: "ok",
        value: { type: "push_vapid_public_key", publicKey: subscription.keys.p256dh },
      },
    });
    for (const requestId of ["push-register", "push-update", "push-remove"]) {
      resolvePendingCommand(pendingCommands, {
        type: "command_result",
        requestId,
        outcome: { status: "ok", value: { type: "void" } },
      });
    }

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual(frames);
    await expect(Promise.all(results)).resolves.toEqual([
      { type: "push_vapid_public_key", publicKey: subscription.keys.p256dh },
      { type: "void" },
      { type: "void" },
      { type: "void" },
    ]);
    expect(pendingCommands.size).toBe(0);
  });
  it("rejects every correlated promise immediately when the socket closes", async () => {
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;
    const pendingCommands = new Map();
    const first = sendBrowserCommand(socket, pendingCommands, {
      type: "push_vapid_public_key",
      requestId: "push-key",
    });
    const second = sendBrowserCommand(socket, pendingCommands, {
      type: "push_subscription_remove",
      requestId: "push-remove",
      deviceId: "device-1",
    });

    rejectPendingCommands(pendingCommands);

    await expect(first).rejects.toThrow("Dashboard disconnected");
    await expect(second).rejects.toThrow("Dashboard disconnected");
    expect(pendingCommands.size).toBe(0);
  });

  it("rejects a correlated push command with the bounded daemon error", async () => {
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;
    const pendingCommands = new Map();
    const request = sendBrowserCommand(socket, pendingCommands, {
      type: "push_subscription_remove",
      requestId: "push-remove-error",
      deviceId: "device-1",
    });
    const daemonError = `private ${"x".repeat(1_000)}`;

    expect(
      resolvePendingCommand(pendingCommands, {
        type: "command_result",
        requestId: "push-remove-error",
        outcome: { status: "error", error: daemonError },
      }),
    ).toBe(true);
    const failure = await request.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toHaveLength(500);
    expect((failure as Error).message.endsWith("…")).toBe(true);
  });
});

describe("server notification frames", () => {
  const notification = {
    type: "notification_event",
    event: "inputRequired",
    title: "Input required",
    body: "Build is waiting for input.",
    tag: "session-session-1-ask-1",
    url: "/?session=session-1",
  } satisfies NotificationEvent;

  it("keeps listeners usable across transport reconnects until explicitly removed", () => {
    const listener = vi.fn();
    const listeners = new Set([listener]);
    dispatchNotificationEvent(listeners, notification);
    dispatchNotificationEvent(listeners, notification);
    listeners.delete(listener);
    dispatchNotificationEvent(listeners, notification);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(notification);
  });

  it("bounds daemon errors before exposing them to callers", () => {
    expect(boundedServerError(null, "The host rejected the command")).toBe("The host rejected the command");
    const message = boundedServerError(`private ${"x".repeat(1_000)}`, "fallback");
    expect(message).toHaveLength(500);
    expect(message.endsWith("…")).toBe(true);
  });
});

describe("session catalog coordination", () => {
  it("does not let an early search cancel or bypass the cached baseline", async () => {
    let finishBaseline: (() => void) | undefined;
    let baselineLoads = 0;
    let searchLoads = 0;
    const baseline = new Promise<void>((resolve) => {
      finishBaseline = resolve;
    });
    const coordinator = createCatalogLoadCoordinator(() => {
      baselineLoads += 1;
      return baseline;
    });

    const baselineLoad = coordinator.loadBaseline();
    const search = coordinator.afterBaseline(async () => {
      searchLoads += 1;
    });

    expect(baselineLoads).toBe(1);
    expect(searchLoads).toBe(0);
    expect(coordinator.loadBaseline()).toBe(baselineLoad);

    finishBaseline?.();
    await search;

    expect(searchLoads).toBe(1);
    expect(baselineLoads).toBe(1);
  });

  it("retries a failed baseline before running a later search", async () => {
    let baselineLoads = 0;
    let searchLoads = 0;
    const coordinator = createCatalogLoadCoordinator(() => {
      baselineLoads += 1;
      return baselineLoads === 1 ? Promise.reject(new Error("Catalog unavailable")) : Promise.resolve();
    });
    const loadSearch = async () => {
      searchLoads += 1;
    };

    await expect(coordinator.afterBaseline(loadSearch)).rejects.toThrow("Catalog unavailable");
    expect(searchLoads).toBe(0);

    await coordinator.afterBaseline(loadSearch);

    expect(baselineLoads).toBe(2);
    expect(searchLoads).toBe(1);
  });

  it("invalidates a cleaned-up attempt without letting its late failure clear the replacement", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    let baselineLoads = 0;
    const firstRequest = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondRequest = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const coordinator = createCatalogLoadCoordinator(() => {
      baselineLoads += 1;
      return baselineLoads === 1 ? firstRequest : secondRequest;
    });

    const firstAttempt = coordinator.loadBaseline();
    coordinator.invalidateBaseline(firstAttempt);
    const secondAttempt = coordinator.loadBaseline();

    expect(secondAttempt).not.toBe(firstAttempt);
    expect(baselineLoads).toBe(2);

    rejectFirst?.(new Error("First StrictMode setup aborted"));
    await expect(firstAttempt).rejects.toThrow("First StrictMode setup aborted");
    expect(coordinator.loadBaseline()).toBe(secondAttempt);

    resolveSecond?.();
    await secondAttempt;
    expect(coordinator.loadBaseline()).toBe(secondAttempt);
  });
});

describe("snapshotSessionsWithCurrentMessages", () => {
  it("preserves hydrated messages while replacing session metadata", () => {
    const snapshot = [
      { ...SESSION, name: "Fresh metadata", parentSessionId: "parent-session", messages: [] },
    ];

    expect(snapshotSessionsWithCurrentMessages(snapshot, [SESSION])).toEqual([
      { ...snapshot[0], messages: SESSION.messages },
    ]);
  });
});

describe("applyTranscriptToSessions", () => {
  it("replaces completed live fallback messages with canonical history while clearing other root history", () => {
    const fallbackCompleted = makeMsg(
      "extension-message-1",
      "Planning precise feature implementation",
      false,
    );
    const target = { ...SESSION, id: "target", source: "extension" as const, messages: [fallbackCompleted] };
    const otherHistory = { ...SESSION, id: "other-history", source: "history" as const };
    const historyChild = {
      ...SESSION,
      id: "history-child",
      source: "history" as const,
      parentSessionId: "other-history",
    };
    const otherLive = { ...SESSION, id: "other-live" };

    const result = applyTranscriptToSessions(
      [target, otherHistory, historyChild, otherLive],
      makePage("target", [makeMsg("ffac29ab", "Planning precise feature implementation", false)]),
    );
    expect(result[0]?.messages.map((m) => m.id)).toEqual(["ffac29ab"]);
    expect(result[0]?.messages[0]?.text).toBe("Planning precise feature implementation");
    expect(result[1]?.messages).toEqual([]);
    expect(result[2]?.messages).toEqual(SESSION.messages);
    expect(result[3]?.messages).toEqual(SESSION.messages);
  });

  it("retains active streaming live tail entries not represented by canonical IDs", () => {
    const fallbackCompleted = makeMsg("extension-message-1", "earlier turn", false);
    const fallbackStreaming = makeMsg("extension-message-2", "streaming in progress", true);
    const target = {
      ...SESSION,
      id: "target",
      source: "extension" as const,
      messages: [fallbackCompleted, fallbackStreaming],
    };

    const result = applyTranscriptToSessions(
      [target],
      makePage("target", [makeMsg("ffac29ab", "earlier turn", false)]),
    );
    expect(result[0]?.messages.map((m) => m.id)).toEqual(["ffac29ab", "extension-message-2"]);
    expect(result[0]?.messages[1]?.streaming).toBe(true);
    expect(result[0]?.messages[1]?.text).toBe("streaming in progress");
  });

  it("updates distinct streaming fallback in place on subsequent upsert without duplication", () => {
    const fallbackStreaming = makeMsg("extension-message-2", "streaming in progress", true);
    const target = {
      ...SESSION,
      id: "target",
      source: "extension" as const,
      messages: [fallbackStreaming],
    };

    const hydrated = applyTranscriptToSessions(
      [target],
      makePage("target", [makeMsg("ffac29ab", "earlier turn", false)]),
    );
    expect(hydrated[0]?.messages.map((m) => m.id)).toEqual(["ffac29ab", "extension-message-2"]);

    const updated = upsertTranscriptMessage(
      hydrated,
      "target",
      makeMsg("extension-message-2", "streaming complete", false),
    );
    expect(updated[0]?.messages.map((m) => m.id)).toEqual(["ffac29ab", "extension-message-2"]);
    expect(updated[0]?.messages[1]?.text).toBe("streaming complete");
    expect(updated[0]?.messages[1]?.streaming).toBe(false);
  });
});
describe("cleanupSessionHistory", () => {
  it("removes provenance-tracked HTTP messages on session switch while retaining completed live tail with fewer than 50 messages", () => {
    const httpMsg = makeMsg("mA-http", "canonical text", false);
    const liveMsg = makeMsg("mA-live", "completed live turn", false);
    const provenance: TranscriptProvenance = new WeakSet([httpMsg]);
    const session = { ...SESSION, id: "sA", messages: [httpMsg, liveMsg] };

    const result = cleanupSessionHistory([session], "sA", provenance);
    expect(result[0]?.messages.map((m) => m.id)).toEqual(["mA-live"]);
  });
});

describe("mergeSessions", () => {
  it("keeps live metadata while merging saved details with concurrent live messages", () => {
    const saved = {
      ...SESSION,
      source: "history" as const,
      id: "child",
      parentSessionId: "root",
      messages: [{ ...SESSION.messages[0]!, id: "saved", text: "saved transcript" }],
    };
    const live = {
      ...SESSION,
      id: "child",
      source: "extension" as const,
      connected: true,
      messages: [{ ...SESSION.messages[0]!, id: "live", text: "live update" }],
    };

    expect(mergeSessions([saved], [live])).toEqual([
      expect.objectContaining({
        id: "child",
        source: "extension",
        connected: true,
        parentSessionId: "root",
        messages: [
          expect.objectContaining({ id: "saved", text: "saved transcript" }),
          expect.objectContaining({ id: "live", text: "live update" }),
        ],
      }),
    ]);
  });
});

describe("mergeTranscriptMessages", () => {
  it("keeps current live versions by identity and appends current-only updates", () => {
    const hydrated = [
      {
        id: "one",
        role: "assistant" as const,
        text: "old",
        timestamp: "2026-08-01T00:00:00.000Z",
        streaming: false,
        presentation: "text" as const,
      },
      {
        id: "two",
        role: "assistant" as const,
        text: "server",
        timestamp: "2026-08-01T00:00:01.000Z",
        streaming: false,
        presentation: "text" as const,
      },
    ];
    const live = [
      {
        id: "one",
        role: "assistant" as const,
        text: "newer live",
        timestamp: "2026-08-01T00:00:02.000Z",
        streaming: true,
        presentation: "text" as const,
      },
      {
        id: "three",
        role: "tool" as const,
        text: "live-only",
        timestamp: "2026-08-01T00:00:03.000Z",
        streaming: false,
        presentation: "text" as const,
      },
    ];

    expect(mergeTranscriptMessages(hydrated, live).map((message) => message.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(mergeTranscriptMessages(hydrated, live)[0]).toEqual(live[0]);
  });
  it("preserves more than 200 messages without slicing", () => {
    const server = Array.from({ length: 150 }, (_, i) => makeMsg(`s-${i}`));
    const current = Array.from({ length: 100 }, (_, i) => makeMsg(`c-${i}`));
    expect(mergeTranscriptMessages(server, current)).toHaveLength(250);
  });
});

describe("upsertTranscriptMessage", () => {
  it("replaces a streaming message in place and advances session activity", () => {
    const sessions = upsertTranscriptMessage([SESSION], "session-1", {
      id: "message-1",
      role: "assistant",
      text: "Streaming complete",
      timestamp: "2026-07-28T22:01:02.000Z",
      streaming: false,
      presentation: "text",
    });

    expect(sessions[0]).toMatchObject({
      lastActivity: "2026-07-28T22:01:02.000Z",
      messages: [{ id: "message-1", text: "Streaming complete", streaming: false }],
    });
    expect(SESSION.messages[0]?.text).toBe("Starting");
  });

  it("preserves tool presentation metadata when replacing a streaming message", () => {
    const sessions = upsertTranscriptMessage([SESSION], "session-1", {
      id: "message-1",
      role: "tool",
      text: "-1|before\n+1|after",
      timestamp: "2026-07-29T12:00:01.000Z",
      streaming: false,
      presentation: "diff",
      toolName: "edit",
    });

    expect(sessions[0]?.messages).toEqual([
      {
        id: "message-1",
        role: "tool",
        text: "-1|before\n+1|after",
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "diff",
        toolName: "edit",
      },
    ]);
    expect(SESSION.messages[0]).toEqual(expect.objectContaining({ text: "Starting", streaming: true }));
  });

  it("leaves unrelated sessions referentially stable", () => {
    const other = { ...SESSION, id: "session-2" };
    const sessions = upsertTranscriptMessage([SESSION, other], "session-1", {
      id: "message-2",
      role: "assistant",
      text: "Next chunk",
      timestamp: "2026-07-28T22:01:03.000Z",
      streaming: true,
      presentation: "text",
    });

    expect(sessions[1]).toBe(other);
    expect(sessions[0]?.messages).toHaveLength(2);
  });
  it("preserves more than 200 messages without slicing", () => {
    const initial = Array.from({ length: 205 }, (_, i) => makeMsg(`m-${i}`));
    const updated = upsertTranscriptMessage([{ ...SESSION, messages: initial }], "session-1", makeMsg("new"));
    expect(updated[0]?.messages).toHaveLength(206);
  });
});
