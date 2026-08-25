import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import ompRemoteExtension, {
  getConfiguredRoleEffort,
  getSessionModelOptions,
  isRpcMode,
  normalizeExtensionMessage,
} from "./extension.js";
import { compatibilityZ, FakeWebSocket, temporaryDirectories } from "./extension.test-support.js";

describe("ompRemoteExtension", () => {
  it("installs one shared-UI relay, routes with the current session, and restores native UI", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "text");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const nativeResult = { kind: "chat" as const };
    const nativeAskDialog = vi.fn(async (_questions: unknown, _options?: unknown) => nativeResult);
    const terminalHandlers = new Set<(data: string) => unknown>();
    const ui = {
      askDialog: nativeAskDialog,
      onTerminalInput: vi.fn((handler: (data: string) => unknown) => {
        terminalHandlers.add(handler);
        return () => terminalHandlers.delete(handler);
      }),
    };
    const createHandlerUi = () => {
      const askDialog = ui.askDialog;
      const scopedAskDialog = (...args: Parameters<typeof nativeAskDialog>) => askDialog(...args);
      return new Proxy(ui, {
        get(target, property, receiver) {
          return property === "askDialog" ? scopedAskDialog : Reflect.get(target, property, receiver);
        },
      });
    };
    const pi = {
      zod: { z: compatibilityZ },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
      getThinkingLevel: vi.fn(() => "high"),
      getCommands: vi.fn(() => []),
    };
    const model = { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" };
    const contextFor = (sessionId: string) => ({
      cwd: "/workspace/project",
      ui: createHandlerUi(),
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      models: { current: () => model, list: () => [model] },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => sessionId,
        getSessionName: () => "Test session",
        getSessionFile: () => null,
      },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
    });
    const firstContext = contextFor("session-1");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    ompRemoteExtension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, firstContext);
    const wrapper = ui.askDialog;
    const currentContext = contextFor("session-2");
    expect(firstContext.ui).not.toBe(currentContext.ui);
    expect(currentContext.ui.askDialog).not.toBe(wrapper);
    await handlers.get("session_switch")?.({}, currentContext);
    const repeatedContext = contextFor("session-2");
    expect(currentContext.ui).not.toBe(repeatedContext.ui);
    await handlers.get("session_switch")?.({}, repeatedContext);
    expect(ui.askDialog).toBe(wrapper);

    const questions = [
      {
        id: "database",
        question: "Which database?",
        options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
        recommended: 1,
      },
    ];
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("The extension did not open its host connection");
    const options = { timeout: 500 };
    const resultPromise = ui.askDialog(questions, options);
    const request = JSON.parse(socket.sent.at(-1) ?? "");
    expect(request).toMatchObject({
      type: "ask_request",
      request: { sessionId: "session-2", kind: "rich", questions },
    });
    await socket.emit("message", {
      data: JSON.stringify({
        command: "ask_unavailable",
        requestId: request.request.requestId,
      }),
    });
    await expect(resultPromise).resolves.toEqual(nativeResult);
    expect(nativeAskDialog).toHaveBeenCalledTimes(1);
    expect(nativeAskDialog).toHaveBeenCalledWith(
      questions,
      expect.objectContaining({ timeout: 500, signal: expect.any(AbortSignal) }),
    );

    await handlers.get("session_shutdown")?.();
    expect(ui.askDialog).toBe(nativeAskDialog);
    expect(terminalHandlers.size).toBe(0);
  });

  it("reinstalls the ask relay across fresh proxied UI contexts on session_switch and agent_start without recursing", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "text");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const nativeResult = { kind: "chat" as const };
    const nativeAskDialog = vi.fn(function (this: unknown, _questions: unknown, _options?: unknown) {
      return { ...nativeResult, receiver: this };
    });

    class BaseUi {
      askDialog = nativeAskDialog;
      onTerminalInput = vi.fn(() => () => {});
    }

    const createFreshUi = () => {
      const base = new BaseUi();
      return new Proxy(base, {
        get(target, property, receiver) {
          return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
          return Reflect.set(target, property, value, receiver);
        },
      });
    };

    const model = { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" };
    const contextFor = (sessionId: string) => ({
      cwd: "/workspace/project",
      ui: createFreshUi(),
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      models: { current: () => model, list: () => [model] },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => sessionId,
        getSessionName: () => "Test session",
        getSessionFile: () => null,
      },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
    });

    const pi = {
      zod: { z: compatibilityZ },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
      getThinkingLevel: vi.fn(() => "high"),
      getCommands: vi.fn(() => []),
    };

    vi.stubGlobal("WebSocket", FakeWebSocket);
    ompRemoteExtension(pi as unknown as ExtensionAPI);

    const initialContext = contextFor("session-1");
    await handlers.get("session_start")?.({}, initialContext);

    const switchContext = contextFor("session-2");
    await handlers.get("session_switch")?.({}, switchContext);

    const agentContext = contextFor("session-2");
    await handlers.get("agent_start")?.({}, agentContext);

    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("The extension did not open its host connection");

    const questions = [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }] }];
    const options = { timeout: 300 };

    const resultPromise = agentContext.ui.askDialog(questions, options);
    const sentRequests = socket.sent
      .map((entry) => JSON.parse(entry))
      .filter((entry) => entry.type === "ask_request");

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toMatchObject({
      type: "ask_request",
      request: { sessionId: "session-2", kind: "rich", questions },
    });

    await socket.emit("message", {
      data: JSON.stringify({
        command: "ask_unavailable",
        requestId: sentRequests[0].request.requestId,
      }),
    });

    const result = await resultPromise;
    expect(result).toMatchObject(nativeResult);
    expect(nativeAskDialog).toHaveBeenCalledTimes(1);
    expect(nativeAskDialog).toHaveBeenCalledWith(
      questions,
      expect.objectContaining({ timeout: 300, signal: expect.any(AbortSignal) }),
    );
  });

  it("presents locally before admission, emits admitted activity, and honors the first valid response or abort", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "text");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const terminalHandlers = new Set<(data: string) => unknown>();
    const nativeAskDialog = vi.fn(
      (_questions: unknown, options: ExtensionUIDialogOptions = {}) =>
        new Promise<undefined>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
        ),
    );
    const ui = {
      askDialog: nativeAskDialog,
      onTerminalInput: (handler: (data: string) => unknown) => {
        terminalHandlers.add(handler);
        return () => terminalHandlers.delete(handler);
      },
    };
    const pi = {
      zod: { z: compatibilityZ },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
      getThinkingLevel: vi.fn(() => "high"),
      getCommands: vi.fn(() => []),
    };
    const context = {
      cwd: "/workspace/project",
      ui,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      models: {
        current: () => ({ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" }),
        list: () => [],
      },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionName: () => null,
        getSessionFile: () => null,
      },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);
    ompRemoteExtension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, context);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("The extension did not open its host connection");
    const questions = [{ id: "database", question: "", options: [{ label: "SQLite" }] }];
    const parentAbort = new AbortController();
    const resultPromise = ui.askDialog(questions, { timeout: 500, signal: parentAbort.signal });
    const request = JSON.parse(socket.sent.at(-1) ?? "");
    expect(nativeAskDialog).toHaveBeenCalledOnce();
    const competingOptions = nativeAskDialog.mock.calls[0]?.[1];
    expect(competingOptions).toEqual(
      expect.objectContaining({ timeout: 500, signal: expect.any(AbortSignal) }),
    );
    expect(terminalHandlers.size).toBe(1);

    await socket.emit("message", {
      data: JSON.stringify({ command: "ask_admitted", requestId: request.request.requestId }),
    });
    expect(terminalHandlers.size).toBe(1);
    for (const handler of terminalHandlers) handler("x");
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toEqual({
      type: "ask_activity",
      sessionId: "session-1",
      requestId: request.request.requestId,
    });

    parentAbort.abort();
    await expect(resultPromise).resolves.toBeUndefined();
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toEqual({
      type: "ask_cancelled",
      sessionId: "session-1",
      requestId: request.request.requestId,
    });
    expect(terminalHandlers.size).toBe(0);

    const remoteResultPromise = ui.askDialog(questions);
    const remoteRequest = JSON.parse(socket.sent.at(-1) ?? "");
    await socket.emit("message", {
      data: JSON.stringify({ command: "ask_admitted", requestId: remoteRequest.request.requestId }),
    });
    await socket.emit("message", {
      data: JSON.stringify({
        command: "ask_response",
        requestId: remoteRequest.request.requestId,
        response: { kind: "chat", unexpected: true },
      }),
    });
    expect(terminalHandlers.size).toBe(1);
    await socket.emit("message", {
      data: JSON.stringify({
        command: "ask_response",
        requestId: remoteRequest.request.requestId,
        response: {
          kind: "submit",
          results: [
            {
              id: "database",
              question: "",
              options: ["SQLite"],
              multi: false,
              selectedOptions: ["SQLite"],
            },
          ],
        },
      }),
    });
    await expect(remoteResultPromise).resolves.toEqual({
      kind: "submit",
      results: [
        {
          id: "database",
          question: "",
          options: ["SQLite"],
          multi: false,
          selectedOptions: ["SQLite"],
        },
      ],
    });
    expect(terminalHandlers.size).toBe(0);
  });
});
