import type { AskRequest, NotificationEvent, Session } from "@omp-remote/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  boundedServerError,
  createCatalogLoadCoordinator,
  commandResultValue,
  dispatchNotificationEvent,
  loadSessionBranchTopology,
  loadSessionCost,
  loadSessionFileChanges,
  overlaySessionCosts,
  patchSession,
  removeAskRequest,
  sessionSourcesReady,
  sendBrowserCommand,
  resolvePendingCommand,
  rejectPendingCommands,
  upsertAskRequest,
  upsertTranscriptMessage,
} from "./index.js";

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

describe("session readiness", () => {
  it("waits for both the live snapshot and baseline catalog", () => {
    expect(sessionSourcesReady(true, false)).toBe(false);
    expect(sessionSourcesReady(false, true)).toBe(false);
    expect(sessionSourcesReady(true, true)).toBe(true);
  });

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
});

describe("patchSession", () => {
  it("updates only the targeted metadata while preserving stable references", () => {
    const other = {
      ...SESSION,
      id: "session-2",
      name: "Unrelated session",
      messages: [],
    };
    const original = [SESSION, other];

    const sessions = patchSession(original, "session-1", {
      name: "Updated session",
      status: "idle",
    });

    expect(SESSION).toMatchObject({
      name: "Stream test",
      status: "running",
    });
    expect(sessions).not.toBe(original);
    expect(sessions[0]).toEqual({
      ...SESSION,
      name: "Updated session",
      status: "idle",
    });
    expect(sessions[0]).not.toBe(SESSION);
    expect(sessions[0]?.messages).toBe(SESSION.messages);
    expect(sessions[1]).toBe(other);
  });

  it("applies model catalog and effort updates from the host", () => {
    const sessions = patchSession([SESSION], "session-1", {
      model: "anthropic/claude-opus-4.7",
      effort: "max",
      availableModels: [
        {
          provider: "anthropic",
          id: "claude-opus-4.7",
          name: "Claude Opus 4.7",
          efforts: ["low", "medium", "high", "max"],
        },
      ],
    });

    expect(sessions[0]).toMatchObject({
      model: "anthropic/claude-opus-4.7",
      effort: "max",
      availableModels: [{ provider: "anthropic", id: "claude-opus-4.7" }],
    });
  });

  it("propagates live cost summary updates", () => {
    const costSummary = {
      totalUsd: 1.75,
      partial: true,
      agents: [
        {
          sessionId: "session-1",
          name: "Stream test",
          parentSessionId: null,
          totalUsd: 1.75,
          available: true,
        },
      ],
    };
    const sessions = patchSession([SESSION], "session-1", { costSummary });
    expect(sessions[0]?.costSummary).toEqual(costSummary);
  });

  it("returns the original array when the session ID is absent", () => {
    const sessions = [SESSION];

    expect(patchSession(sessions, "missing-session", { status: "idle" })).toBe(sessions);
  });
});

describe("overlaySessionCosts", () => {
  it("restores the selected exact summary after a metadata-only source replacement", () => {
    const costSummary = {
      totalUsd: 2.5,
      partial: false,
      agents: [
        {
          sessionId: SESSION.id,
          name: SESSION.name ?? SESSION.id,
          parentSessionId: null,
          totalUsd: 2.5,
          available: true,
        },
      ],
    };
    const replacement = { ...SESSION };
    const overlaid = overlaySessionCosts([replacement], new Map([[SESSION.id, costSummary]]));

    expect(overlaid[0]).toEqual({ ...replacement, costSummary });
    expect(overlaid[0]).not.toBe(replacement);
  });

  it("removes a stale summary only when the selected response is explicitly unavailable", () => {
    const withCost = {
      ...SESSION,
      costSummary: { totalUsd: 1, partial: false, agents: [] },
    };
    expect(overlaySessionCosts([withCost], new Map([[SESSION.id, null]]))[0]?.costSummary).toBeUndefined();
    const unchanged = [SESSION];
    expect(overlaySessionCosts(unchanged, new Map())).toBe(unchanged);
  });
});

describe("remote ask request state", () => {
  const firstRequest: AskRequest = {
    sessionId: "session-1",
    requestId: "ask-1",
    kind: "select",
    title: "Which database?",
    options: ["SQLite", "PostgreSQL"],
    initialValue: null,
    expiresAt: null,
  };

  it("replaces the active request for a session in place", () => {
    const otherRequest = { ...firstRequest, sessionId: "session-2", requestId: "ask-2" };
    const nextRequest = {
      ...firstRequest,
      requestId: "ask-3",
      kind: "text" as const,
      title: "Type another answer",
      options: [],
    };

    expect(upsertAskRequest([firstRequest, otherRequest], nextRequest)).toEqual([nextRequest, otherRequest]);
  });

  it("removes only the matching request", () => {
    const newerRequest = { ...firstRequest, requestId: "ask-2" };

    expect(removeAskRequest([newerRequest], "session-1", "ask-1")).toEqual([newerRequest]);
    expect(removeAskRequest([newerRequest], "session-1", "ask-2")).toEqual([]);
  });
});

describe("loadSessionCost", () => {
  it("requests only the encoded selected session and validates the exact summary", async () => {
    const costSummary = {
      totalUsd: 1.25,
      partial: false,
      agents: [
        {
          sessionId: "session/a",
          name: "Selected",
          parentSessionId: null,
          totalUsd: 1.25,
          available: true,
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "session/a", costSummary }), { status: 200 }),
      );

    await expect(loadSessionCost("session/a", undefined, fetcher)).resolves.toEqual({
      sessionId: "session/a",
      costSummary,
    });
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/cost", {});
  });

  it("preserves an explicit unavailable summary and reports request failures", async () => {
    const unavailableFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "session-1", costSummary: null }), { status: 200 }),
      );
    await expect(loadSessionCost("session-1", undefined, unavailableFetcher)).resolves.toEqual({
      sessionId: "session-1",
      costSummary: null,
    });

    const failedFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(loadSessionCost("session-1", undefined, failedFetcher)).rejects.toThrow(
      "Session cost request failed (500)",
    );
  });

  it("rejects a response for a different session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "session-2", costSummary: null }), { status: 200 }),
      );
    await expect(loadSessionCost("session-1", undefined, fetcher)).rejects.toThrow(
      "Session cost response did not match the request",
    );
  });
});

describe("loadSessionBranchTopology", () => {
  const availableResponse = {
    sessionId: "session/a",
    branches: [{ name: "main" }, { name: "feature/child", parent: "main" }],
    currentBranch: "feature/child",
  };

  it("requests the encoded branches route and validates its schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await expect(loadSessionBranchTopology("session/a", undefined, fetcher)).resolves.toEqual(
      availableResponse,
    );
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/branches", {});
  });

  it("passes the cancellation signal to fetch", async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await loadSessionBranchTopology("session/a", controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/branches", {
      signal: controller.signal,
    });
  });

  it("propagates the exact host error text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Cannot switch branches while the session is running." }), {
        status: 409,
      }),
    );

    await expect(loadSessionBranchTopology("session-1", undefined, fetcher)).rejects.toThrow(
      "Cannot switch branches while the session is running.",
    );
  });
  it("preserves an abort raised while reading a failed response", async () => {
    const controller = new AbortController();
    const abortFailure = new Error("Topology response read aborted");
    abortFailure.name = "AbortError";
    const response = {
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw abortFailure;
      }),
    } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(loadSessionBranchTopology("session-1", controller.signal, fetcher)).rejects.toBe(
      abortFailure,
    );
  });

  it("rejects a successful response that violates the topology schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...availableResponse, unexpected: true }), { status: 200 }),
      );

    await expect(loadSessionBranchTopology("session-1", undefined, fetcher)).rejects.toThrow();
  });
});

describe("loadSessionFileChanges", () => {
  const availableResponse = {
    sessionId: "session/a",
    state: "available",
    sources: [],
    fileCount: 0,
    operationCount: 0,
    additions: 0,
    deletions: 0,
    changedLines: 0,
    message: null,
  };

  it("requests the encoded changes route and validates its schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await expect(loadSessionFileChanges("session/a", undefined, fetcher)).resolves.toEqual(availableResponse);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/changes", {});
  });

  it("passes the cancellation signal to fetch", async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await loadSessionFileChanges("session/a", controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/changes", {
      signal: controller.signal,
    });
  });

  it("propagates host errors before parsing an error body as a response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Session file changes could not be read" }), {
        status: 500,
      }),
    );

    await expect(loadSessionFileChanges("session-1", undefined, fetcher)).rejects.toThrow(
      "Session file changes could not be read",
    );
  });

  it.each([
    ["non-JSON", new Response("<html>Bad gateway</html>", { status: 502 }), 502],
    [
      "unreadable",
      {
        ok: false,
        status: 503,
        json: vi.fn().mockRejectedValue(new Error("Response body is unavailable")),
      } as unknown as Response,
      503,
    ],
  ])("uses the status fallback for a %s non-OK response", async (_kind, response, status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(loadSessionFileChanges("session-1", undefined, fetcher)).rejects.toThrow(
      `Session file changes request failed (${status})`,
    );
  });

  it("preserves cancellation when a non-OK response body read aborts", async () => {
    const controller = new AbortController();
    const abortFailure = new Error("Response body read aborted");
    abortFailure.name = "AbortError";
    const response = {
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw abortFailure;
      }),
    } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(loadSessionFileChanges("session-1", controller.signal, fetcher)).rejects.toBe(abortFailure);
  });

  it("rejects a successful response that violates the changes schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...availableResponse, operationCount: 1 }), { status: 200 }),
      );

    await expect(loadSessionFileChanges("session-1", undefined, fetcher)).rejects.toThrow();
  });
});
