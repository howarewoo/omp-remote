import { EventEmitter } from "node:events";
import {
  type ApplicationErrorRecord,
  type AskRequest,
  ServerFrameSchema,
  type Session,
} from "@omp-remote/protocol";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ApplicationErrorStore } from "./application-error-store.js";
import { MAX_BROWSER_BUFFERED_BYTES } from "./browser-broadcast.js";
import {
  browserSnapshotSessions,
  pendingAskRequestsForBrowserSnapshot,
  registerBrowserWebSocketRoute,
  removeBrowserSocket,
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
    const socket = {};
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
