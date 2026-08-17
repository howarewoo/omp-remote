import { EventEmitter } from "node:events";
import {
  type AskRequest,
  type ExtensionFrame,
  type Session,
  type SessionModelOption,
  type TranscriptMessage,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { applyRpcSessionMetadata, registerExtensionWebSocketRoute } from "./extension-websocket.js";

const TEST_MODELS: SessionModelOption[] = [
  {
    provider: "openai",
    id: "gpt-5.6",
    name: "GPT-5.6",
    efforts: ["high"],
    roles: ["slow"],
    roleEfforts: { slow: "high" },
  },
];
const FRAME: Extract<ExtensionFrame, { type: "metadata" }> = {
  type: "metadata",
  sessionId: "session-rpc-1",
  availableModels: TEST_MODELS,
};
const RPC_SESSION = {
  id: FRAME.sessionId,
  source: "rpc" as const,
  connected: true,
  availableModels: [] as SessionModelOption[],
};

function fakeRegistry(getSession: () => typeof RPC_SESSION | undefined): SessionRegistry {
  return {
    get: getSession,
    update: (_id: string, patch: Partial<typeof RPC_SESSION>) => Object.assign(getSession()!, patch),
  } as unknown as SessionRegistry;
}

describe("applyRpcSessionMetadata", () => {
  it("patches the exact connected RPC session", async () => {
    const session = { ...RPC_SESSION };
    await expect(
      applyRpcSessionMetadata({
        frame: FRAME,
        registry: fakeRegistry(() => session),
        socketClosed: Promise.resolve(),
        isCancelled: () => false,
      }),
    ).resolves.toBe(true);
    expect(session.availableModels).toEqual(TEST_MODELS);
  });

  it("admits the newest metadata waiter after the RPC launch race", async () => {
    let session: typeof RPC_SESSION | undefined;
    let generation = 0;
    const registry = fakeRegistry(() => session);
    const socketClosed = new Promise<void>(() => undefined);
    const first = applyRpcSessionMetadata({
      frame: FRAME,
      registry,
      socketClosed,
      isCancelled: () => generation !== 0,
    });
    generation = 1;
    const second = applyRpcSessionMetadata({
      frame: FRAME,
      registry,
      socketClosed,
      isCancelled: () => generation !== 1,
    });
    session = { ...RPC_SESSION };

    await expect(Promise.all([first, second])).resolves.toEqual([false, true]);
    expect(session.availableModels).toEqual(TEST_MODELS);
  });

  it("updates only availableModels and preserves source, messages, capabilities, and status", async () => {
    const session = {
      ...RPC_SESSION,
      messages: [
        {
          id: "m1",
          role: "user" as const,
          text: "hello",
          presentation: "text" as const,
          timestamp: "2026-08-17T00:00:00.000Z",
          streaming: false,
        },
      ],
      capabilities: ["model" as const, "effort" as const],
      status: "busy" as const,
    };
    await expect(
      applyRpcSessionMetadata({
        frame: FRAME,
        registry: fakeRegistry(() => session as unknown as typeof RPC_SESSION),
        socketClosed: Promise.withResolvers<void>().promise,
        isCancelled: () => false,
      }),
    ).resolves.toBe(true);
    expect(session.availableModels).toEqual(TEST_MODELS);
    expect(session.source).toBe("rpc");
    expect(session.messages).toHaveLength(1);
    expect(session.capabilities).toEqual(["model", "effort"]);
    expect(session.status).toBe("busy");
  });

  it("ignores non-RPC sessions and disconnected sessions", async () => {
    const extensionSession = {
      ...RPC_SESSION,
      source: "extension" as const,
      availableModels: [],
    };
    await expect(
      applyRpcSessionMetadata({
        frame: FRAME,
        registry: fakeRegistry(() => extensionSession as unknown as typeof RPC_SESSION),
        socketClosed: Promise.withResolvers<void>().promise,
        isCancelled: () => false,
      }),
    ).resolves.toBe(false);
    expect(extensionSession.availableModels).toEqual([]);

    const disconnectedSession = {
      ...RPC_SESSION,
      connected: false,
      availableModels: [],
    };
    await expect(
      applyRpcSessionMetadata({
        frame: FRAME,
        registry: fakeRegistry(() => disconnectedSession),
        socketClosed: Promise.withResolvers<void>().promise,
        isCancelled: () => false,
      }),
    ).resolves.toBe(false);
    expect(disconnectedSession.availableModels).toEqual([]);
  });

  it("stops waiting when socket closes before RPC session connects", async () => {
    const { promise: socketClosed, resolve: closeSocket } = Promise.withResolvers<void>();
    let isSocketClosed = false;
    const pending = applyRpcSessionMetadata({
      frame: FRAME,
      registry: fakeRegistry(() => undefined),
      socketClosed,
      isCancelled: () => isSocketClosed,
    });
    isSocketClosed = true;
    closeSocket();
    await expect(pending).resolves.toBe(false);
  });
});

class FakeExtensionWebSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close");
  }

  receiveFrame(frame: ExtensionFrame) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  receiveRaw(data: string) {
    this.emit("message", Buffer.from(data));
  }
}

const BASE_EXTENSION_SESSION: Session = {
  id: "session-live-1",
  source: "extension",
  name: "Live Terminal",
  cwd: "/work/test",
  branch: null,
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  effort: "high",
  availableModels: TEST_MODELS,
  contextPercent: 10,
  createdAt: "2026-08-17T00:00:00.000Z",
  lastActivity: "2026-08-17T00:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume", "model", "effort"],
  messages: [],
  sessionPath: null,
  activeSubagents: [],
  skillCommands: [],
};

function createExtensionEventFrame(
  event: "agent_start" | "agent_end" | "message_start" | "message_update" | "message_end",
  message: TranscriptMessage | null,
  sessionId = "session-live-1",
): Extract<ExtensionFrame, { type: "event" }> {
  return {
    type: "event",
    sessionId,
    event,
    message,
    name: "Live Terminal",
    model: "openai/gpt-5.6",
    contextPercent: 10,
    effort: "high",
  };
}

function createTestHarness(overrides: Partial<Parameters<typeof registerExtensionWebSocketRoute>[1]> = {}) {
  const extensionSockets = overrides.extensionSockets ?? new Map<string, WebSocket>();
  const extensionSessionBySocket = overrides.extensionSessionBySocket ?? new Map<WebSocket, string>();
  const pendingAskBySession = overrides.pendingAskBySession ?? new Map();
  const sessionCatalog = overrides.sessionCatalog ?? {
    get: vi.fn(() => undefined),
  };
  const registry = overrides.registry ?? new SessionRegistry();
  const registerExtensionSession = overrides.registerExtensionSession ?? vi.fn(async () => true);
  const sanitizeExtensionSession =
    overrides.sanitizeExtensionSession ?? (<T extends { messages: TranscriptMessage[] }>(s: T) => s);
  const sanitizeTranscriptMessageImages =
    overrides.sanitizeTranscriptMessageImages ?? ((m: TranscriptMessage) => m);
  const refreshSessionBranch = overrides.refreshSessionBranch ?? vi.fn();
  const sendExtensionAskUnavailable = overrides.sendExtensionAskUnavailable ?? vi.fn();
  const setPendingAsk = overrides.setPendingAsk ?? vi.fn();
  const clearPendingAsk = overrides.clearPendingAsk ?? vi.fn();
  const expirePendingAsk = overrides.expirePendingAsk ?? vi.fn();
  const markSessionHistorical = overrides.markSessionHistorical ?? vi.fn();
  const broadcast = overrides.broadcast ?? vi.fn();
  const isLoopbackAddress = overrides.isLoopbackAddress ?? (() => true);

  let routeHandler: ((socket: WebSocket, request: { ip: string }) => void) | undefined;
  const app = {
    get: vi.fn((_path, _opts, handler) => {
      routeHandler = handler;
    }),
  } as unknown as FastifyInstance;

  registerExtensionWebSocketRoute(app, {
    extensionSockets,
    extensionSessionBySocket,
    pendingAskBySession,
    sessionCatalog: sessionCatalog as unknown as Parameters<
      typeof registerExtensionWebSocketRoute
    >[1]["sessionCatalog"],
    registry,
    registerExtensionSession,
    sanitizeExtensionSession,
    sanitizeTranscriptMessageImages,
    refreshSessionBranch,
    sendExtensionAskUnavailable,
    setPendingAsk,
    clearPendingAsk,
    expirePendingAsk,
    markSessionHistorical,
    broadcast,
    isLoopbackAddress,
  });

  const connectSocket = (ip = "127.0.0.1") => {
    const socket = new FakeExtensionWebSocket() as unknown as WebSocket & FakeExtensionWebSocket;
    routeHandler!(socket, { ip });
    return socket;
  };

  return {
    connectSocket,
    extensionSockets,
    extensionSessionBySocket,
    pendingAskBySession,
    sessionCatalog,
    registry,
    registerExtensionSession,
    refreshSessionBranch,
    sendExtensionAskUnavailable,
    setPendingAsk,
    clearPendingAsk,
    expirePendingAsk,
    markSessionHistorical,
    broadcast,
  };
}

describe("registerExtensionWebSocketRoute", () => {
  it("publishes fresh unknown-topology session immediately before catalog reconciliation resolves", async () => {
    const { promise: reconcilePromise, resolve: resolveReconcile } = Promise.withResolvers<boolean>();
    const registerExtensionSession = vi.fn(async () => reconcilePromise);
    const harness = createTestHarness({ registerExtensionSession });
    const socket = harness.connectSocket();

    socket.receiveFrame({ type: "register", session: BASE_EXTENSION_SESSION });

    // Published immediately into registry with unknown provisional topology
    await vi.waitFor(() => {
      const published = harness.registry.get("session-live-1");
      expect(published).toBeDefined();
      expect(published).toMatchObject({
        id: "session-live-1",
        name: "Live Terminal",
        connected: true,
        status: "running",
      });
      expect(published?.parentSessionId).toBeUndefined();
      expect(harness.extensionSockets.get("session-live-1")).toBe(socket);
      expect(harness.extensionSessionBySocket.get(socket)).toBe("session-live-1");
      expect(harness.refreshSessionBranch).toHaveBeenCalledWith("session-live-1", "/work/test");
    });

    // Complete catalog reconciliation
    resolveReconcile(true);
    await vi.waitFor(() => {
      expect(harness.registerExtensionSession).toHaveBeenCalled();
    });
  });

  it("retains the persisted user prompt in order without duplication across second registration and queued assistant events", async () => {
    const harness = createTestHarness();
    const socket = harness.connectSocket();

    // 1. Initial register at session_start with empty messages
    socket.receiveFrame({ type: "register", session: BASE_EXTENSION_SESSION });
    await vi.waitFor(() => {
      expect(harness.registry.get("session-live-1")?.messages).toEqual([]);
    });

    // 2. Second register at agent_start with user prompt
    const userMessage: TranscriptMessage = {
      id: "msg-user-1",
      role: "user",
      text: "Implement live terminal fix",
      timestamp: "2026-08-17T00:00:01.000Z",
      streaming: false,
      presentation: "text",
    };
    socket.receiveFrame({
      type: "register",
      session: { ...BASE_EXTENSION_SESSION, messages: [userMessage] },
    });

    // 3. Followed immediately by queued event frames
    socket.receiveFrame(createExtensionEventFrame("agent_start", null));
    const assistantStreaming: TranscriptMessage = {
      id: "msg-assistant-1",
      role: "assistant",
      text: "Analyzing task...",
      timestamp: "2026-08-17T00:00:02.000Z",
      streaming: true,
      presentation: "text",
    };
    socket.receiveFrame(createExtensionEventFrame("message_start", assistantStreaming));
    const assistantFinal: TranscriptMessage = {
      id: "msg-assistant-1",
      role: "assistant",
      text: "Analyzing task... Completed analysis.",
      timestamp: "2026-08-17T00:00:03.000Z",
      streaming: false,
      presentation: "text",
    };
    socket.receiveFrame(createExtensionEventFrame("message_end", assistantFinal));

    await vi.waitFor(() => {
      const session = harness.registry.get("session-live-1");
      expect(session).toBeDefined();
      expect(session?.messages).toHaveLength(2);
      expect(session?.messages[0]).toEqual(userMessage);
      expect(session?.messages[1]).toEqual(assistantFinal);
      expect(session?.status).toBe("running");
    });
  });

  it("prevents superseded older generation from overwriting prompt-bearing newer generation", async () => {
    const firstReconcile = Promise.withResolvers<boolean>();
    const secondReconcile = Promise.withResolvers<boolean>();
    let callCount = 0;
    const registerExtensionSession = vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? firstReconcile.promise : secondReconcile.promise;
    });
    const harness = createTestHarness({ registerExtensionSession });
    const socket = harness.connectSocket();

    // Gen 1 (empty messages)
    socket.receiveFrame({ type: "register", session: BASE_EXTENSION_SESSION });
    await vi.waitFor(() => {
      expect(harness.registry.get("session-live-1")).toBeDefined();
    });

    // Gen 2 (prompt-bearing)
    const userMessage: TranscriptMessage = {
      id: "msg-user-1",
      role: "user",
      text: "User prompt",
      timestamp: "2026-08-17T00:00:01.000Z",
      streaming: false,
      presentation: "text",
    };
    socket.receiveFrame({
      type: "register",
      session: { ...BASE_EXTENSION_SESSION, messages: [userMessage] },
    });
    await vi.waitFor(() => {
      expect(harness.registry.get("session-live-1")?.messages).toEqual([userMessage]);
    });

    // Gen 2 completes
    secondReconcile.resolve(true);
    await vi.waitFor(() => {
      expect(harness.registry.get("session-live-1")?.messages).toEqual([userMessage]);
    });

    // Gen 1 resolves late
    firstReconcile.resolve(true);
    await vi.waitFor(() => {
      expect(harness.registry.get("session-live-1")?.messages).toEqual([userMessage]);
    });
  });

  it("cleans up replaced socket ownership, invalidates pending asks, and avoids marking session historical on replaced socket closure", async () => {
    const harness = createTestHarness();
    const socket1 = harness.connectSocket();
    socket1.receiveFrame({ type: "register", session: BASE_EXTENSION_SESSION });
    await vi.waitFor(() => {
      expect(harness.registry.get("session-live-1")).toBeDefined();
    });

    // Socket 1 sends an ask request
    const askRequest: AskRequest = {
      sessionId: "session-live-1",
      requestId: "ask-1",
      kind: "rich",
      questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }],
      expiresAt: null,
    };
    socket1.receiveFrame({ type: "ask_request", request: askRequest });
    await vi.waitFor(() => {
      expect(harness.setPendingAsk).toHaveBeenCalledWith(askRequest, "extension");
      expect(JSON.parse(socket1.sent.at(-1) ?? "")).toMatchObject({
        command: "ask_admitted",
        requestId: "ask-1",
      });
    });

    // Mock pending ask in harness
    harness.pendingAskBySession.set("session-live-1", {
      request: askRequest,
      source: "extension",
      timeout: undefined,
    });

    // Socket 2 connects for the same session (replacement)
    const socket2 = harness.connectSocket();
    socket2.receiveFrame({ type: "register", session: BASE_EXTENSION_SESSION });
    await vi.waitFor(() => {
      expect(harness.extensionSockets.get("session-live-1")).toBe(socket2);
      expect(harness.extensionSessionBySocket.get(socket2)).toBe("session-live-1");
      expect(harness.sendExtensionAskUnavailable).toHaveBeenCalledWith("session-live-1", "ask-1");
      expect(harness.clearPendingAsk).toHaveBeenCalledWith("session-live-1", "ask-1");
    });

    // Late ask on old socket is rejected
    socket1.receiveFrame({ type: "ask_request", request: { ...askRequest, requestId: "ask-late" } });
    await vi.waitFor(() => {
      expect(JSON.parse(socket1.sent.at(-1) ?? "")).toMatchObject({
        command: "ask_unavailable",
        requestId: "ask-late",
      });
    });

    // Stale heartbeat, event, and command_result from displaced socket1 after takeover do not mutate registry or broadcast
    socket1.receiveFrame({
      type: "heartbeat",
      sessionId: "session-live-1",
      name: "Stale Takeover Name",
      model: "openai/gpt-5.6",
      contextPercent: 50,
      effort: "low",
      idle: true,
    });
    socket1.receiveFrame(
      createExtensionEventFrame("message_update", {
        id: "stale-takeover-msg",
        role: "assistant",
        text: "stale takeover update",
        timestamp: "2026-08-17T00:00:05.000Z",
        streaming: true,
        presentation: "text",
      }),
    );
    socket1.receiveFrame({
      type: "command_result",
      requestId: "stale-takeover-cmd",
      ok: true,
      error: null,
    });

    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(harness.registry.get("session-live-1")?.name).toBe("Live Terminal");
    expect(harness.registry.get("session-live-1")?.messages.some((m) => m.id === "stale-takeover-msg")).toBe(
      false,
    );
    expect(harness.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "stale-takeover-cmd" }),
    );

    // Replaced socket close does not mark session historical
    socket1.close();
    expect(harness.markSessionHistorical).not.toHaveBeenCalled();
    expect(harness.extensionSockets.get("session-live-1")).toBe(socket2);

    // Active socket close marks session historical
    socket2.close();
    await vi.waitFor(() => {
      expect(harness.markSessionHistorical).toHaveBeenCalledWith("session-live-1");
    });

    // Stale frames from displaced socket1 after replacement closes do not reconnect session, append messages, or broadcast
    socket1.receiveFrame({
      type: "heartbeat",
      sessionId: "session-live-1",
      name: "Late Post-Close Heartbeat",
      model: "openai/gpt-5.6",
      contextPercent: 50,
      effort: "low",
      idle: true,
    });
    socket1.receiveFrame(
      createExtensionEventFrame("message_end", {
        id: "late-post-close-msg",
        role: "assistant",
        text: "late post-close msg",
        timestamp: "2026-08-17T00:00:06.000Z",
        streaming: false,
        presentation: "text",
      }),
    );
    socket1.receiveFrame({
      type: "command_result",
      requestId: "late-post-close-cmd",
      ok: true,
      error: null,
    });

    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(harness.registry.get("session-live-1")?.name).toBe("Live Terminal");
    expect(harness.registry.get("session-live-1")?.messages.some((m) => m.id === "late-post-close-msg")).toBe(
      false,
    );
    expect(harness.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "late-post-close-cmd" }),
    );
  });

  it("discards queued frames and clears pending ask when socket closes", async () => {
    const { promise: reconcilePromise, resolve: resolveReconcile } = Promise.withResolvers<boolean>();
    const harness = createTestHarness({ registerExtensionSession: vi.fn(async () => reconcilePromise) });
    const socket = harness.connectSocket();

    socket.receiveFrame({ type: "register", session: BASE_EXTENSION_SESSION });
    socket.receiveFrame(createExtensionEventFrame("agent_start", null));
    socket.close();
    resolveReconcile(true);
    await vi.waitFor(() => {
      expect(harness.markSessionHistorical).toHaveBeenCalledWith("session-live-1");
    });
  });
});
