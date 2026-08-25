import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import ompRemoteExtension, {
  getConfiguredRoleEffort,
  getSessionModelOptions,
  isRpcMode,
  normalizeExtensionMessage,
  normalizeRemoteAskResponse,
} from "./extension.js";

const compatibilityZ = { ...z };
Reflect.deleteProperty(compatibilityZ, "discriminatedUnion");

const originalArgv = [...process.argv];
const temporaryDirectories: string[] = [];

type Listener = (event: { data?: string }) => void | Promise<void>;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readyState = FakeWebSocket.OPEN;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  async emit(type: string, event: { data?: string } = {}) {
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
}

afterEach(async () => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.instances.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

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

  it("returns remote timeout results and keeps one native Ask alive across admitted socket loss", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "text");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const localResolvers: Array<(value: { kind: "chat" } | undefined) => void> = [];
    const nativeAskDialog = vi.fn(
      (_questions: unknown, options: ExtensionUIDialogOptions = {}) =>
        new Promise<{ kind: "chat" } | undefined>((resolve) => {
          localResolvers.push(resolve);
          options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
    const ui = {
      askDialog: nativeAskDialog,
      onTerminalInput: () => vi.fn(),
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
    const questions = [
      {
        id: "database",
        question: "",
        options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
        recommended: 1,
      },
    ];
    const onTimeout = vi.fn();
    const timeoutPromise = ui.askDialog(questions, { timeout: 500, onTimeout });
    const timeoutRequest = JSON.parse(socket.sent.at(-1) ?? "");
    await socket.emit("message", {
      data: JSON.stringify({ command: "ask_admitted", requestId: timeoutRequest.request.requestId }),
    });
    await socket.emit("message", {
      data: JSON.stringify({
        command: "ask_response",
        requestId: timeoutRequest.request.requestId,
        response: { cancelled: true, timedOut: true },
      }),
    });
    await expect(timeoutPromise).resolves.toEqual({
      kind: "submit",
      results: [
        {
          id: "database",
          question: "",
          options: ["SQLite", "PostgreSQL"],
          multi: false,
          selectedOptions: ["PostgreSQL"],
          timedOut: true,
        },
      ],
    });
    expect(onTimeout).toHaveBeenCalledOnce();

    const fallbackOptions = { timeout: 500 };
    const fallbackPromise = ui.askDialog(questions, fallbackOptions);
    const fallbackRequest = JSON.parse(socket.sent.at(-1) ?? "");
    await socket.emit("message", {
      data: JSON.stringify({ command: "ask_admitted", requestId: fallbackRequest.request.requestId }),
    });
    expect(nativeAskDialog).toHaveBeenCalledTimes(2);
    expect(nativeAskDialog.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ timeout: 500, signal: expect.any(AbortSignal) }),
    );
    await socket.emit("close");
    expect(nativeAskDialog).toHaveBeenCalledTimes(2);
    localResolvers.at(-1)?.({ kind: "chat" });
    await expect(fallbackPromise).resolves.toEqual({ kind: "chat" });
  });

  it("publishes one unsettled disconnected Ask per connection with its activity-refreshed deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "text");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const localResolvers: Array<(value: { kind: "chat" } | undefined) => void> = [];
    const nativeAskDialog = vi.fn(
      (_questions: unknown, options: ExtensionUIDialogOptions = {}) =>
        new Promise<{ kind: "chat" } | undefined>((resolve) => {
          localResolvers.push(resolve);
          options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
    const terminalHandlers = new Set<(data: string) => unknown>();
    const ui = {
      askDialog: nativeAskDialog,
      onTerminalInput: vi.fn((handler: (data: string) => unknown) => {
        terminalHandlers.add(handler);
        return () => terminalHandlers.delete(handler);
      }),
    };
    const pi = {
      zod: { z: compatibilityZ },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
      getThinkingLevel: vi.fn(() => "high"),
      getCommands: vi.fn(() => []),
    };
    let reconnect: (() => void) | undefined;
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
      setTimeout: vi.fn((callback: () => void) => {
        reconnect = callback;
        return 0;
      }),
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);
    ompRemoteExtension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, context);
    const firstSocket = FakeWebSocket.instances[0];
    if (!firstSocket) throw new Error("The extension did not open its host connection");
    firstSocket.readyState = FakeWebSocket.CONNECTING;
    const questions = [{ id: "database", question: "", options: [{ label: "SQLite" }] }];

    const onTimeoutReset = vi.fn();
    const remoteResultPromise = ui.askDialog(questions, { timeout: 500, onTimeoutReset });
    expect(nativeAskDialog).toHaveBeenCalledOnce();
    expect(nativeAskDialog.mock.calls[0]?.[1]?.onTimeoutReset).toBe(onTimeoutReset);
    expect(terminalHandlers.size).toBe(1);
    expect(
      firstSocket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "ask_request"),
    ).toHaveLength(0);

    firstSocket.readyState = FakeWebSocket.OPEN;
    await firstSocket.emit("open");
    await firstSocket.emit("open");
    const firstRequests = firstSocket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "ask_request");
    expect(firstRequests).toHaveLength(1);
    expect(firstRequests[0].request.expiresAt).toBe("2026-08-19T00:00:00.500Z");
    const sentBeforeUnadmittedInput = firstSocket.sent.length;
    vi.setSystemTime(new Date("2026-08-19T00:00:00.100Z"));
    for (const handler of terminalHandlers) handler("unadmitted activity");
    expect(firstSocket.sent).toHaveLength(sentBeforeUnadmittedInput);
    expect(onTimeoutReset).not.toHaveBeenCalled();

    await firstSocket.emit("message", {
      data: JSON.stringify({
        command: "ask_admitted",
        requestId: firstRequests[0].request.requestId,
      }),
    });
    vi.setSystemTime(new Date("2026-08-19T00:00:00.250Z"));
    for (const handler of terminalHandlers) handler("admitted activity");
    expect(JSON.parse(firstSocket.sent.at(-1) ?? "")).toEqual({
      type: "ask_activity",
      sessionId: "session-1",
      requestId: firstRequests[0].request.requestId,
    });
    expect(onTimeoutReset).not.toHaveBeenCalled();

    firstSocket.readyState = 3;
    await firstSocket.emit("close");
    if (!reconnect) throw new Error("The extension did not schedule its reconnect");
    reconnect();
    const secondSocket = FakeWebSocket.instances[1];
    if (!secondSocket) throw new Error("The extension did not reconnect its host socket");
    await secondSocket.emit("open");
    await secondSocket.emit("open");
    const secondRequests = secondSocket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "ask_request");
    expect(secondRequests).toHaveLength(1);
    expect(secondRequests[0].request).toEqual({
      ...firstRequests[0].request,
      expiresAt: "2026-08-19T00:00:00.750Z",
    });

    await secondSocket.emit("message", {
      data: JSON.stringify({
        command: "ask_admitted",
        requestId: secondRequests[0].request.requestId,
      }),
    });
    await secondSocket.emit("message", {
      data: JSON.stringify({
        command: "ask_response",
        requestId: secondRequests[0].request.requestId,
        response: { kind: "chat" },
      }),
    });
    await expect(remoteResultPromise).resolves.toEqual({ kind: "chat" });
    expect(terminalHandlers.size).toBe(0);

    secondSocket.readyState = FakeWebSocket.CONNECTING;
    const localResultPromise = ui.askDialog(questions, { timeout: 500 });
    expect(nativeAskDialog).toHaveBeenCalledTimes(2);
    expect(
      secondSocket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "ask_request"),
    ).toHaveLength(1);
    localResolvers.at(-1)?.({ kind: "chat" });
    await expect(localResultPromise).resolves.toEqual({ kind: "chat" });

    secondSocket.readyState = FakeWebSocket.OPEN;
    await secondSocket.emit("open");
    expect(
      secondSocket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "ask_request"),
    ).toHaveLength(1);

    const localWinnerPromise = ui.askDialog(questions);
    const connectedRequests = secondSocket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "ask_request");
    expect(connectedRequests).toHaveLength(2);
    const localWinnerRequest = connectedRequests.at(-1);
    localResolvers.at(-1)?.({ kind: "chat" });
    await expect(localWinnerPromise).resolves.toEqual({ kind: "chat" });
    expect(JSON.parse(secondSocket.sent.at(-1) ?? "")).toEqual({
      type: "ask_cancelled",
      sessionId: "session-1",
      requestId: localWinnerRequest.request.requestId,
    });
    await secondSocket.emit("message", {
      data: JSON.stringify({
        command: "ask_response",
        requestId: localWinnerRequest.request.requestId,
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
    await expect(localWinnerPromise).resolves.toEqual({ kind: "chat" });
  });

  it.each([
    [{ kind: "chat" }, { type: "response", response: { kind: "chat" } }],
    [{ cancelled: true }, { type: "response", response: undefined }],
    [{ cancelled: true, timedOut: true }, { type: "timeout" }],
  ])("normalizes remote rich ask terminal responses", (response, expected) => {
    expect(normalizeRemoteAskResponse(response)).toEqual(expected);
  });

  it("sends metadata frames for top-level RPC sessions without full registration or lifecycle ownership", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "rpc-ui");
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-extension-root-"));
    temporaryDirectories.push(directory);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const model = {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      thinking: { requiresEffort: false, efforts: ["low", "high"] as const },
    };
    const pi = {
      zod: { z: compatibilityZ },
      pi: {
        settings: { getModelRole: (c: string) => (c === "default" ? "openai/gpt-5.6:high" : undefined) },
      },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
      getThinkingLevel: () => "high" as const,
      getCommands: () => [],
    };
    const origAsk = vi.fn();
    const context = {
      cwd: directory,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      abort: vi.fn(),
      ui: { askDialog: origAsk },
      models: {
        current: () => model,
        list: () => [model],
        resolve: (v: string) => (v === "openai/gpt-5.6" || v === "@default" ? model : undefined),
      },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-rpc-root",
        getSessionName: () => "Root",
        getSessionFile: () => join(directory, "main.jsonl"),
      },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);
    ompRemoteExtension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, context);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("Expected extension WebSocket");
    expect(context.ui.askDialog).toBe(origAsk);
    await socket.emit("open");
    const expected = {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      efforts: ["off", "low", "high"],
      roles: ["default"],
      roleEfforts: { default: "high" },
    };
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      type: "metadata",
      sessionId: "session-rpc-root",
      availableModels: [expected],
    });
    expect(context.setInterval).toHaveBeenCalledWith(expect.any(Function), 10_000);
    const intervalCallback = vi.mocked(context.setInterval).mock.calls[0]?.[0] as () => void;
    intervalCallback();
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
      type: "metadata",
      sessionId: "session-rpc-root",
      availableModels: [expected],
    });

    await handlers.get("agent_start")?.({}, context);
    await handlers.get("agent_end")?.({}, context);
    await handlers.get("message_start")?.({ message: { role: "user", content: "hi" } }, context);
    await handlers.get("message_update")?.({ message: { role: "user", content: "hi update" } }, context);
    await handlers.get("message_end")?.({ message: { role: "user", content: "hi done" } }, context);
    expect(socket.sent).toHaveLength(2);
    expect(context.ui.askDialog).toBe(origAsk);

    await handlers.get("session_switch")?.(
      {},
      {
        ...context,
        sessionManager: { ...context.sessionManager, getSessionId: () => "session-rpc-switched" },
      },
    );
    expect(JSON.parse(socket.sent[2] ?? "")).toEqual({
      type: "metadata",
      sessionId: "session-rpc-switched",
      availableModels: [expected],
    });
    const closeSpy = vi.spyOn(socket, "close");
    await handlers.get("session_shutdown")?.();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("sends an initial snapshot at session_start and a refreshed prompt-bearing snapshot at agent_start before its event frame", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "text");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      zod: { z: compatibilityZ },
      pi: {
        settings: {
          getModelRole: (role: string) => (role === "default" ? "openai/gpt-5.6:high" : undefined),
        },
      },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getThinkingLevel: vi.fn(() => "high"),
      getCommands: vi.fn(() => []),
      sendUserMessage: vi.fn(),
      setModel: vi.fn(),
      setThinkingLevel: vi.fn(),
    };

    const model = { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" };
    let branch: unknown[] = [];
    const context = {
      cwd: "/workspace/project",
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      abort: vi.fn(),
      models: {
        current: () => model,
        list: () => [model],
        resolve: (value: string) => (value === "openai/gpt-5.6" || value === "@default" ? model : undefined),
      },
      sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "session-live-terminal",
        getSessionName: () => "Live Terminal Session",
        getSessionFile: () => null,
      },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);

    ompRemoteExtension(pi as unknown as ExtensionAPI);

    // 1. session_start sends initial empty snapshot upon socket connection
    await handlers.get("session_start")?.({}, context);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("Socket not created");
    await socket.emit("open");

    expect(socket.sent).toHaveLength(1);
    const initialFrame = JSON.parse(socket.sent[0] ?? "");
    expect(initialFrame).toEqual({
      type: "register",
      session: expect.objectContaining({
        id: "session-live-terminal",
        name: "Live Terminal Session",
        messages: [],
      }),
    });

    // 2. User inputs a prompt in the terminal, adding a user message to the session branch
    const userPromptEntry = {
      id: "msg-user-1",
      type: "message",
      message: {
        id: "msg-user-1",
        role: "user",
        content: [{ type: "text", text: "Fix live terminal registration" }],
        timestamp: "2026-08-17T00:00:00.000Z",
      },
    };
    branch = [
      {
        type: "custom_message",
        customType: "skill-prompt",
        content: "skill wrapper\nUser: Original request",
      },
      userPromptEntry,
    ];

    // 3. agent_start fires: sends refreshed prompt-bearing snapshot followed by agent_start event frame
    await handlers.get("agent_start")?.({}, context);

    expect(socket.sent).toHaveLength(3);
    const refreshedRegisterFrame = JSON.parse(socket.sent[1] ?? "");
    const agentStartEventFrame = JSON.parse(socket.sent[2] ?? "");

    expect(refreshedRegisterFrame).toEqual({
      type: "register",
      session: expect.objectContaining({
        id: "session-live-terminal",
        name: "Live Terminal Session",
        messages: [
          expect.objectContaining({
            id: expect.stringMatching(/^skill-prompt-/),
            role: "user",
            text: "Original request",
          }),
          expect.objectContaining({
            id: "msg-user-1",
            role: "user",
            text: "Fix live terminal registration",
          }),
        ],
      }),
    });

    expect(agentStartEventFrame).toEqual({
      type: "event",
      sessionId: "session-live-terminal",
      event: "agent_start",
      message: null,
      name: "Live Terminal Session",
      model: "openai/gpt-5.6",
      contextPercent: null,
      effort: "high",
    });
  });
});
