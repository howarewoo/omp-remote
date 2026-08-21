import { EventEmitter } from "node:events";
import type { RpcSession } from "@omp-remote/omp-rpc";
import {
  type ApplicationErrorRecord,
  type AskRequest,
  ServerFrameSchema,
  type Session,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ApplicationErrorStore } from "./application-error-store.js";
import { MAX_BROWSER_BUFFERED_BYTES } from "./browser-broadcast.js";
import {
  browserSnapshotSessions,
  executeRpcSessionCommand,
  FORWARDED_EXTENSION_COMMAND_TIMEOUT_MS,
  type ForwardedExtensionCommand,
  pendingAskRequestsForBrowserSnapshot,
  registerBrowserWebSocketRoute,
  removeBrowserSocket,
  removeForwardedCommandsForBrowser,
  respondToPendingAsk,
} from "./browser-websocket.js";

const pendingAsk: AskRequest = {
  kind: "text",
  sessionId: "root",
  requestId: "ask-1",
  title: "Which option?",
  options: [],
  initialValue: null,
  expiresAt: null,
};

describe("browser WebSocket snapshot", () => {
  it("sends only connected sessions with bounded metadata", () => {
    const base: Session = {
      id: "live",
      source: "extension",
      name: "Live",
      cwd: "/tmp/live",
      branch: "main",
      status: "idle",
      connected: true,
      model: null,
      contextPercent: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActivity: "2026-08-01T00:00:00.000Z",
      capabilities: [],
      messages: [
        {
          id: "message",
          role: "user",
          text: "private",
          timestamp: "2026-08-01T00:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
      sessionPath: null,
      activeSubagents: [],
      skillCommands: [],
    };

    const child = { ...base, id: "child", parentSessionId: "missing-parent" };
    expect(browserSnapshotSessions([base, child, { ...base, id: "offline", connected: false }])).toEqual([
      { ...base, messages: [] },
      { ...child, messages: [] },
    ]);
  });

  it("turns an oversized transcript snapshot into a parseable bounded frame without dropping other state", () => {
    const oversizedSession: Session = {
      id: "oversized",
      source: "extension",
      name: "Oversized",
      cwd: "/tmp/oversized",
      branch: "main",
      status: "running",
      connected: true,
      model: null,
      contextPercent: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActivity: "2026-08-01T00:00:00.000Z",
      capabilities: [],
      messages: [
        {
          id: "large-message",
          role: "assistant",
          text: "x".repeat(MAX_BROWSER_BUFFERED_BYTES + 1),
          timestamp: "2026-08-01T00:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
      sessionPath: null,
      activeSubagents: [],
      skillCommands: [],
    };
    const original = JSON.stringify({
      type: "snapshot",
      sessions: [oversizedSession],
      askRequests: [pendingAsk],
      savedWorkingDirectories: ["/tmp/work"],
    });
    const bounded = JSON.stringify({
      type: "snapshot",
      sessions: browserSnapshotSessions([oversizedSession]),
      askRequests: [pendingAsk],
      savedWorkingDirectories: ["/tmp/work"],
    });

    expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(MAX_BROWSER_BUFFERED_BYTES);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThan(MAX_BROWSER_BUFFERED_BYTES);
    expect(ServerFrameSchema.parse(JSON.parse(bounded))).toMatchObject({
      sessions: [{ id: oversizedSession.id, messages: [] }],
      askRequests: [pendingAsk],
      savedWorkingDirectories: ["/tmp/work"],
    });
  });
});

describe("browser WebSocket Ask lifecycle", () => {
  it("retains an admitted extension Ask when the last browser disconnects for reconnect", () => {
    const socket = {} as WebSocket;
    const browserSockets = new Set([socket]);
    const pendingAskBySession = new Map([
      [pendingAsk.sessionId, { request: pendingAsk, source: "extension" as const, timeout: undefined }],
    ]);
    removeBrowserSocket(browserSockets, socket);

    expect(browserSockets).toEqual(new Set());
    expect(pendingAskRequestsForBrowserSnapshot(pendingAskBySession)).toEqual([pendingAsk]);
  });

  it("answers the retained extension Ask from a later browser response exactly once", async () => {
    const send = vi.fn();
    const extensionSocket = { readyState: 1, send } as unknown as WebSocket;
    const pendingAskBySession = new Map([
      [pendingAsk.sessionId, { request: pendingAsk, source: "extension" as const, timeout: undefined }],
    ]);
    const clearPendingAsk = vi.fn((sessionId: string, requestId?: string) => {
      if (pendingAskBySession.get(sessionId)?.request.requestId === requestId) {
        pendingAskBySession.delete(sessionId);
      }
    });
    const response = await respondToPendingAsk(
      {
        type: "ask_response",
        requestId: "browser-response-1",
        sessionId: pendingAsk.sessionId,
        askRequestId: pendingAsk.requestId,
        response: { value: "PostgreSQL" },
      },
      {
        pendingAskBySession,
        rpcSessions: new Map(),
        extensionSockets: new Map([[pendingAsk.sessionId, extensionSocket]]),
        clearPendingAsk,
      },
    );

    expect(response).toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      command: "ask_response",
      requestId: pendingAsk.requestId,
      response: { value: "PostgreSQL" },
    });
    expect(clearPendingAsk).toHaveBeenCalledOnce();
    expect(pendingAskBySession).toEqual(new Map());
  });
});

describe("browser WebSocket report_application_error", () => {
  it("records validated browser error, broadcasts committed frame, and responds with ok command result", async () => {
    const socketEmitter = new EventEmitter();
    const socket = Object.assign(socketEmitter, {
      close: vi.fn(),
    }) as unknown as WebSocket;

    const recorded: ApplicationErrorRecord = {
      id: "err-browser-1",
      timestamp: "2026-08-16T12:00:00.000Z",
      source: "browser",
      severity: "error",
      message: "Dashboard React tree unhandled exception",
      errorName: "Error",
      stack: "Error: Crash\n    at Dashboard (app.js:1:1)",
      context: { route: "/sessions" },
    };

    const errorStore = {
      record: vi.fn().mockResolvedValue(recorded),
    } as unknown as ApplicationErrorStore;

    const sentFrames: unknown[] = [];
    const broadcastFrames: unknown[] = [];
    const sendToBrowser = vi.fn((_ws, frame) => sentFrames.push(frame));
    const broadcast = vi.fn((frame) => broadcastFrames.push(frame));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    let wsHandler: ((socket: WebSocket, req: unknown) => void) | undefined;
    const app = {
      get: vi.fn((_path, _opts, handler) => {
        wsHandler = handler;
      }),
    } as unknown as Parameters<typeof registerBrowserWebSocketRoute>[0];

    registerBrowserWebSocketRoute(app, {
      browserSockets: new Set(),
      pendingAskBySession: new Map(),
      pushSubscriptions: { publicKey: "key" } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["pushSubscriptions"],
      savedWorkingDirectories: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["savedWorkingDirectories"],
      rpcSessions: new Map(),
      extensionSockets: new Map(),
      registry: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["registry"],
      sendToBrowser,
      broadcast,
      launchRpcSession: vi.fn(),
      branchSwitchBlocksSessionCommand: vi.fn().mockResolvedValue(false),
      switchSessionBranch: vi.fn(),
      refreshRpcState: vi.fn(),
      clearPendingAsk: vi.fn(),
      expirePendingAsk: vi.fn(),
      originAllowed: () => true,
      logger,
      errorStore,
    });

    expect(wsHandler).toBeDefined();
    wsHandler!(socket, { headers: { origin: "http://127.0.0.1:5173", host: "127.0.0.1:3000" } });

    const command = {
      type: "report_application_error",
      requestId: "req-err-1",
      error: {
        message: "Dashboard React tree unhandled exception",
        errorName: "Error",
        stack: "Error: Crash\n    at Dashboard (app.js:1:1)",
        context: { route: "/sessions" },
      },
    };

    socketEmitter.emit("message", Buffer.from(JSON.stringify(command)));
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorStore.record).toHaveBeenCalledWith({
      source: "browser",
      severity: "error",
      message: "Dashboard React tree unhandled exception",
      errorName: "Error",
      stack: "Error: Crash\n    at Dashboard (app.js:1:1)",
      context: { route: "/sessions" },
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "application_error_added",
      error: recorded,
    });
    expect(sendToBrowser).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        type: "command_result",
        requestId: "req-err-1",
        outcome: { status: "ok", value: { type: "void" } },
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("handles storage persistence failure by sending error result without broadcasting and without recursive error logging", async () => {
    const socketEmitter = new EventEmitter();
    const socket = Object.assign(socketEmitter, {
      close: vi.fn(),
    }) as unknown as WebSocket;

    const errorStore = {
      record: vi.fn().mockRejectedValue(new Error("Disk I/O error")),
    } as unknown as ApplicationErrorStore;

    const sendToBrowser = vi.fn();
    const broadcast = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    let wsHandler: ((socket: WebSocket, req: unknown) => void) | undefined;
    const app = {
      get: vi.fn((_path, _opts, handler) => {
        wsHandler = handler;
      }),
    } as unknown as Parameters<typeof registerBrowserWebSocketRoute>[0];

    registerBrowserWebSocketRoute(app, {
      browserSockets: new Set(),
      pendingAskBySession: new Map(),
      pushSubscriptions: { publicKey: "key" } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["pushSubscriptions"],
      savedWorkingDirectories: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["savedWorkingDirectories"],
      rpcSessions: new Map(),
      extensionSockets: new Map(),
      registry: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["registry"],
      sendToBrowser,
      broadcast,
      launchRpcSession: vi.fn(),
      branchSwitchBlocksSessionCommand: vi.fn().mockResolvedValue(false),
      switchSessionBranch: vi.fn(),
      refreshRpcState: vi.fn(),
      clearPendingAsk: vi.fn(),
      expirePendingAsk: vi.fn(),
      originAllowed: () => true,
      logger,
      errorStore,
    });

    wsHandler!(socket, { headers: { origin: "http://127.0.0.1:5173", host: "127.0.0.1:3000" } });

    const command = {
      type: "report_application_error",
      requestId: "req-err-2",
      error: {
        message: "Network request timeout",
      },
    };

    socketEmitter.emit("message", Buffer.from(JSON.stringify(command)));
    await new Promise((resolve) => setImmediate(resolve));

    expect(broadcast).not.toHaveBeenCalled();
    expect(sendToBrowser).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        type: "command_result",
        requestId: "req-err-2",
        outcome: { status: "error", error: "Disk I/O error" },
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to record browser application error",
      expect.objectContaining({ requestId: "req-err-2" }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rejects invalid browser commands with warn logging and without recursive error logging", async () => {
    const socketEmitter = new EventEmitter();
    const socket = Object.assign(socketEmitter, {
      close: vi.fn(),
    }) as unknown as WebSocket;

    const sendToBrowser = vi.fn();
    const broadcast = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    let wsHandler: ((socket: WebSocket, req: unknown) => void) | undefined;
    const app = {
      get: vi.fn((_path, _opts, handler) => {
        wsHandler = handler;
      }),
    } as unknown as Parameters<typeof registerBrowserWebSocketRoute>[0];

    registerBrowserWebSocketRoute(app, {
      browserSockets: new Set(),
      pendingAskBySession: new Map(),
      pushSubscriptions: { publicKey: "key" } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["pushSubscriptions"],
      savedWorkingDirectories: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["savedWorkingDirectories"],
      rpcSessions: new Map(),
      extensionSockets: new Map(),
      registry: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["registry"],
      sendToBrowser,
      broadcast,
      launchRpcSession: vi.fn(),
      branchSwitchBlocksSessionCommand: vi.fn().mockResolvedValue(false),
      switchSessionBranch: vi.fn(),
      refreshRpcState: vi.fn(),
      clearPendingAsk: vi.fn(),
      expirePendingAsk: vi.fn(),
      originAllowed: () => true,
      logger,
    });

    wsHandler!(socket, { headers: { origin: "http://127.0.0.1:5173", host: "127.0.0.1:3000" } });

    socketEmitter.emit("message", Buffer.from("invalid-json{"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith(
      "Rejected dashboard command",
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(sendToBrowser).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        type: "error",
        message: "The dashboard command was not valid.",
      }),
    );
  });

  it("marks launch command failures with scope: command so they are not captured as application errors", async () => {
    const socketEmitter = new EventEmitter();
    const socket = Object.assign(socketEmitter, {
      close: vi.fn(),
    }) as unknown as WebSocket;

    const sendToBrowser = vi.fn();
    const broadcast = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    let wsHandler: ((socket: WebSocket, req: unknown) => void) | undefined;
    const app = {
      get: vi.fn((_path, _opts, handler) => {
        wsHandler = handler;
      }),
    } as unknown as Parameters<typeof registerBrowserWebSocketRoute>[0];

    registerBrowserWebSocketRoute(app, {
      browserSockets: new Set(),
      pendingAskBySession: new Map(),
      pushSubscriptions: { publicKey: "key" } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["pushSubscriptions"],
      savedWorkingDirectories: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["savedWorkingDirectories"],
      rpcSessions: new Map(),
      extensionSockets: new Map(),
      registry: { list: () => [] } as unknown as Parameters<
        typeof registerBrowserWebSocketRoute
      >[1]["registry"],
      sendToBrowser,
      broadcast,
      launchRpcSession: vi.fn().mockRejectedValue(new Error("No model specified")),
      branchSwitchBlocksSessionCommand: vi.fn().mockResolvedValue(false),
      switchSessionBranch: vi.fn(),
      refreshRpcState: vi.fn(),
      clearPendingAsk: vi.fn(),
      expirePendingAsk: vi.fn(),
      originAllowed: () => true,
      logger,
    });

    wsHandler!(socket, { headers: { origin: "http://127.0.0.1:5173", host: "127.0.0.1:3000" } });

    socketEmitter.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "launch",
          requestId: "launch-req-1",
          cwd: "/workspace/my-project",
          resume: null,
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to launch OMP RPC session",
      expect.any(Error),
      expect.objectContaining({
        scope: "command",
        cwd: "/workspace/my-project",
      }),
    );
    expect(sendToBrowser).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        type: "command_result",
        requestId: "launch-req-1",
        outcome: { status: "error", error: "No model specified" },
      }),
    );
  });
});

describe("executeRpcSessionCommand", () => {
  const rpcSession = {
    id: "session-rpc-1",
    availableModels: [
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude 4",
        efforts: ["high"] as const,
        roles: ["slow"],
        roleEfforts: { slow: "high" as const },
      },
    ],
  };

  it("resolves configured @role with concrete model and thinking level", async () => {
    const registry = { get: () => rpcSession } as unknown as SessionRegistry;
    const requests: unknown[] = [];
    const rpc = { request: vi.fn(async (req) => requests.push(req)) } as unknown as RpcSession;
    const refresh = vi.fn(async () => undefined);
    await executeRpcSessionCommand(
      {
        type: "session_command",
        requestId: "r-1",
        sessionId: "session-rpc-1",
        command: "set_model",
        model: "@slow",
      },
      rpc,
      registry,
      refresh,
    );
    expect(requests).toEqual([
      { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4" },
      { type: "set_thinking_level", level: "high" },
    ]);
    expect(refresh).toHaveBeenCalledWith("session-rpc-1", rpc);
  });

  it("handles missing role and thinking level failure without partial mutation", async () => {
    const registry = { get: () => rpcSession } as unknown as SessionRegistry;
    const rpc = {
      request: vi.fn(async (req) => {
        if (req.type === "set_thinking_level") throw new Error("level failed");
      }),
    } as unknown as RpcSession;
    const refresh = vi.fn(async () => undefined);
    await expect(
      executeRpcSessionCommand(
        {
          type: "session_command",
          requestId: "r-2",
          sessionId: "session-rpc-1",
          command: "set_model",
          model: "@missing",
        },
        rpc,
        registry,
        refresh,
      ),
    ).rejects.toThrow("Role @missing is not configured on this session.");
    expect(rpc.request).not.toHaveBeenCalled();

    await expect(
      executeRpcSessionCommand(
        {
          type: "session_command",
          requestId: "r-3",
          sessionId: "session-rpc-1",
          command: "set_model",
          model: "@slow",
        },
        rpc,
        registry,
        refresh,
      ),
    ).rejects.toThrow("level failed");
    expect(refresh).toHaveBeenCalledWith("session-rpc-1", rpc);
  });
});

describe("browser WebSocket extension command forwarding", () => {
  it("records correlation and forwards command to open extension socket, then removes on browser close", async () => {
    const socketEmitter = new EventEmitter();
    const browserSocket = Object.assign(socketEmitter, {
      readyState: 1,
      close: vi.fn(),
    }) as unknown as WebSocket;

    const extensionSent: string[] = [];
    const extensionSocket = {
      readyState: 1,
      send: vi.fn((payload: string) => extensionSent.push(payload)),
    } as unknown as WebSocket;

    const forwardedExtensionCommands = new Map<string, ForwardedExtensionCommand>();
    const extensionSockets = new Map([["session-ext-1", extensionSocket]]);
    const sendToBrowser = vi.fn();
    const broadcast = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    let wsHandler: ((socket: WebSocket, req: unknown) => void) | undefined;
    const app = {
      get: vi.fn((path, opts, handler) => {
        wsHandler = handler;
      }),
    };

    registerBrowserWebSocketRoute(app as any, {
      forwardedExtensionCommands,
      browserSockets: new Set([browserSocket]),
      pendingAskBySession: new Map(),
      pushSubscriptions: { publicKey: "key" } as any,
      savedWorkingDirectories: { list: () => [] } as any,
      rpcSessions: new Map(),
      extensionSockets,
      registry: { list: () => [] } as any,
      sendToBrowser,
      broadcast,
      launchRpcSession: vi.fn(),
      branchSwitchBlocksSessionCommand: vi.fn(async () => false),
      switchSessionBranch: vi.fn(),
      refreshRpcState: vi.fn(),
      clearPendingAsk: vi.fn(),
      expirePendingAsk: vi.fn(),
      originAllowed: () => true,
      logger: logger as any,
    });

    wsHandler?.(browserSocket, { headers: { host: "127.0.0.1:3000" } });

    const commandPayload = {
      type: "session_command",
      requestId: "req-fwd-1",
      sessionId: "session-ext-1",
      command: "prompt",
      text: "hello extension",
    };
    socketEmitter.emit("message", Buffer.from(JSON.stringify(commandPayload)));

    await new Promise((resolve) => setImmediate(resolve));

    expect(extensionSocket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(extensionSent[0] ?? "")).toEqual(commandPayload);
    const entry = forwardedExtensionCommands.get("req-fwd-1");
    expect(entry).toBeDefined();
    expect(entry?.requestId).toBe("req-fwd-1");
    expect(entry?.timeoutId).toBeDefined();

    // Browser closes: correlation is removed and timeout cleared without broadcasting
    socketEmitter.emit("close");
    expect(forwardedExtensionCommands.has("req-fwd-1")).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("expires forwarded command after 20 seconds and notifies originating browser", async () => {
    vi.useFakeTimers();
    try {
      const socketEmitter = new EventEmitter();
      const browserSocket = Object.assign(socketEmitter, {
        readyState: 1,
        close: vi.fn(),
      }) as unknown as WebSocket;
      const extensionSocket = {
        readyState: 1,
        send: vi.fn(),
      } as unknown as WebSocket;

      const forwardedExtensionCommands = new Map<string, ForwardedExtensionCommand>();
      const extensionSockets = new Map([["session-ext-1", extensionSocket]]);
      const sendToBrowser = vi.fn();
      const broadcast = vi.fn();

      let wsHandler: ((socket: WebSocket, req: unknown) => void) | undefined;
      const app = {
        get: vi.fn((path, opts, handler) => {
          wsHandler = handler;
        }),
      };

      registerBrowserWebSocketRoute(app as any, {
        forwardedExtensionCommands,
        browserSockets: new Set([browserSocket]),
        pendingAskBySession: new Map(),
        pushSubscriptions: { publicKey: "key" } as any,
        savedWorkingDirectories: { list: () => [] } as any,
        rpcSessions: new Map(),
        extensionSockets,
        registry: { list: () => [] } as any,
        sendToBrowser,
        broadcast,
        launchRpcSession: vi.fn(),
        branchSwitchBlocksSessionCommand: vi.fn(async () => false),
        switchSessionBranch: vi.fn(),
        refreshRpcState: vi.fn(),
        clearPendingAsk: vi.fn(),
        expirePendingAsk: vi.fn(),
        originAllowed: () => true,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      });

      wsHandler?.(browserSocket, { headers: { host: "127.0.0.1:3000" } });

      const commandPayload = {
        type: "session_command",
        requestId: "req-expire-1",
        sessionId: "session-ext-1",
        command: "prompt",
        text: "timed command",
      };
      socketEmitter.emit("message", Buffer.from(JSON.stringify(commandPayload)));

      await vi.advanceTimersByTimeAsync(0);

      expect(forwardedExtensionCommands.has("req-expire-1")).toBe(true);

      await vi.advanceTimersByTimeAsync(FORWARDED_EXTENSION_COMMAND_TIMEOUT_MS);

      expect(forwardedExtensionCommands.has("req-expire-1")).toBe(false);
      expect(sendToBrowser).toHaveBeenCalledWith(browserSocket, {
        type: "command_result",
        requestId: "req-expire-1",
        outcome: {
          status: "error",
          error: "The host did not respond before the command timed out",
        },
      });
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
