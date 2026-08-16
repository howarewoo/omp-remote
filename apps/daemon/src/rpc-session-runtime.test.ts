import type { Logger } from "@omp-remote/observability";
import type { RpcFrame, RpcSession } from "@omp-remote/omp-rpc";
import type { Session } from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createRpcSessionRuntime } from "./rpc-session-runtime.js";
import type { SessionCatalog } from "./session-catalog.js";

const { mockRpcInstances, rpcControl } = vi.hoisted(() => {
  type MockSessionType = {
    listeners: Set<(frame: RpcFrame) => void>;
    start: Mock<() => Promise<RpcFrame>>;
    request: Mock<(command: RpcFrame) => Promise<RpcFrame>>;
    terminate: Mock<() => Promise<void>>;
    subscribe: Mock<(listener: (frame: RpcFrame) => void) => () => void>;
  };

  const mockRpcInstances: MockSessionType[] = [];
  const rpcControl = {
    nextStart: vi.fn<() => Promise<RpcFrame>>(),
    nextRequest: vi.fn<(command: RpcFrame) => Promise<RpcFrame>>(),
  };

  return { mockRpcInstances, rpcControl };
});

vi.mock("@omp-remote/omp-rpc", () => {
  class MockRpcSession {
    listeners = new Set<(frame: RpcFrame) => void>();
    start = vi.fn(() => rpcControl.nextStart());
    request = vi.fn((command: RpcFrame) => rpcControl.nextRequest(command));
    terminate = vi.fn().mockResolvedValue(undefined);
    subscribe = vi.fn((listener: (frame: RpcFrame) => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });

    constructor() {
      mockRpcInstances.push(this);
    }
  }

  return { RpcSession: MockRpcSession };
});

vi.mock("./git-branch.js", () => ({
  resolveGitBranch: vi.fn().mockResolvedValue("main"),
}));

describe("RpcSessionRuntime launch deadline and disposal", () => {
  let registry: SessionRegistry;
  let rpcSessions: Map<string, RpcSession>;
  let sessionCatalogGet: Mock<(id: string) => Session | undefined>;
  let sessionCatalog: SessionCatalog;
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRpcInstances.length = 0;
    rpcControl.nextStart.mockReset();
    rpcControl.nextRequest.mockReset();
    registry = new SessionRegistry();
    rpcSessions = new Map<string, RpcSession>();
    sessionCatalogGet = vi.fn();
    sessionCatalog = {
      get: sessionCatalogGet,
      refresh: vi.fn().mockResolvedValue({ upserted: [], removed: [] }),
    } as unknown as SessionCatalog;
    logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects at the 15-second deadline without waiting for process termination", async () => {
    const { promise: startPromise } = Promise.withResolvers<RpcFrame>();
    rpcControl.nextStart.mockReturnValue(startPromise);

    const runtime = createRpcSessionRuntime({
      environment: { OMP_REMOTE_OMP_PATH: "/usr/local/bin/omp" },
      registry,
      rpcSessions,
      sessionCatalog,
      requestCatalogReconciliation: vi.fn().mockResolvedValue(undefined),
      setPendingAsk: vi.fn(),
      clearPendingAsk: vi.fn(),
      markSessionHistorical: vi.fn(),
      logger,
    });

    const launchPromise = runtime.launchRpcSession("/test/project", null);
    const rejection = expect(launchPromise).rejects.toThrow("OMP RPC session launch timed out");

    const rpcInstance = mockRpcInstances[0];
    expect(rpcInstance).toBeDefined();
    if (!rpcInstance) throw new Error("Expected one RPC session");
    const { promise: neverTerminates } = Promise.withResolvers<void>();
    rpcInstance.terminate.mockReturnValue(neverTerminates);
    expect(rpcInstance.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(rpcInstance.terminate).toHaveBeenCalledOnce();
    expect(registry.get("test-session")).toBeUndefined();
    expect(rpcSessions.size).toBe(0);
  });

  it("prevents late registration when pre-registration resolves after the deadline", async () => {
    const { promise: startPromise, resolve: resolveStart } = Promise.withResolvers<RpcFrame>();
    rpcControl.nextStart.mockReturnValue(startPromise);
    rpcControl.nextRequest.mockImplementation(async (command: RpcFrame) => {
      if (command.type === "get_available_commands") {
        return { type: "response", command: "get_available_commands", success: true, data: { commands: [] } };
      }
      if (command.type === "get_available_models") {
        return { type: "response", command: "get_available_models", success: true, data: { models: [] } };
      }
      if (command.type === "get_messages") {
        return { type: "response", command: "get_messages", success: true, data: { messages: [] } };
      }
      return {
        type: "response",
        command: typeof command.type === "string" ? command.type : "unknown",
        success: true,
        data: {},
      };
    });

    const runtime = createRpcSessionRuntime({
      environment: { OMP_REMOTE_OMP_PATH: "/usr/local/bin/omp" },
      registry,
      rpcSessions,
      sessionCatalog,
      requestCatalogReconciliation: vi.fn().mockResolvedValue(undefined),
      setPendingAsk: vi.fn(),
      clearPendingAsk: vi.fn(),
      markSessionHistorical: vi.fn(),
      logger,
    });

    const launchPromise = runtime.launchRpcSession("/test/project", null);
    const rpcInstance = mockRpcInstances[0];
    expect(rpcInstance).toBeDefined();
    if (!rpcInstance) throw new Error("Expected one RPC session");

    const rejection = expect(launchPromise).rejects.toThrow("OMP RPC session launch timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    sessionCatalogGet.mockReturnValue({
      id: "late-session-id",
      source: "rpc",
      name: "Late Session",
      cwd: "/test/project",
      branch: "main",
      status: "idle",
      connected: true,
      model: null,
      contextPercent: null,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      capabilities: [],
      messages: [],
      sessionPath: null,
      parentSessionId: null,
      activeSubagents: [],
      skillCommands: [],
    });

    // Late resolution of start()
    resolveStart({
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "late-session-id", sessionName: "Late Session", isStreaming: false },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(registry.get("late-session-id")).toBeUndefined();
    expect(rpcSessions.has("late-session-id")).toBe(false);
  });

  it("registers a successful fresh launch without waiting for catalog persistence", async () => {
    rpcControl.nextStart.mockResolvedValue({
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "successful-session", sessionName: "Fast Session", isStreaming: false },
    });
    rpcControl.nextRequest.mockImplementation(async (command: RpcFrame) => {
      if (command.type === "get_available_commands") {
        return { type: "response", command: "get_available_commands", success: true, data: { commands: [] } };
      }
      if (command.type === "get_available_models") {
        return { type: "response", command: "get_available_models", success: true, data: { models: [] } };
      }
      if (command.type === "get_messages") {
        return { type: "response", command: "get_messages", success: true, data: { messages: [] } };
      }
      return {
        type: "response",
        command: typeof command.type === "string" ? command.type : "unknown",
        success: true,
        data: {},
      };
    });

    const runtime = createRpcSessionRuntime({
      environment: { OMP_REMOTE_OMP_PATH: "/usr/local/bin/omp" },
      registry,
      rpcSessions,
      sessionCatalog,
      requestCatalogReconciliation: vi.fn().mockResolvedValue(undefined),
      setPendingAsk: vi.fn(),
      clearPendingAsk: vi.fn(),
      markSessionHistorical: vi.fn(),
      logger,
    });

    const launchPromise = runtime.launchRpcSession("/test/project", null);
    const rpcInstance = mockRpcInstances[0];
    expect(rpcInstance).toBeDefined();
    if (!rpcInstance) throw new Error("Expected one RPC session");

    const session = await launchPromise;
    expect(session.id).toBe("successful-session");
    expect(registry.get("successful-session")).toBeDefined();
    expect(session.parentSessionId).toBeNull();
    expect(rpcSessions.get("successful-session")).toBe(rpcInstance as unknown as RpcSession);

    // Advance timers well beyond the 15-second launch deadline
    await vi.advanceTimersByTimeAsync(30_000);

    // Ensure the registered session is NEVER terminated by the deadline
    expect(rpcInstance.terminate).not.toHaveBeenCalled();
  });
});
