import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompRemoteExtension, {
  getComposerCommandCatalog,
  getConfiguredRoleEffort,
  getSessionModelOptions,
  isRpcMode,
  normalizeRemoteAskResponse,
  normalizeExtensionMessage,
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
  FakeWebSocket.instances.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("normalizeExtensionMessage", () => {
  it("drops non-text assistant content", () => {
    expect(
      normalizeExtensionMessage(
        { id: "assistant-thinking", role: "assistant", content: [{ type: "thinking" }] },
        true,
        "fallback-id",
      ),
    ).toBeNull();
  });

  it("keeps empty live tool results", () => {
    expect(
      normalizeExtensionMessage(
        { id: "empty-tool-result", role: "toolResult", content: [{ type: "status" }] },
        true,
        "fallback-id",
      ),
    ).toMatchObject({
      id: "empty-tool-result",
      role: "tool",
      text: "",
      streaming: true,
    });
  });
});

describe("ompRemoteExtension", () => {
  it("recognizes hosted RPC modes without suppressing other modes", () => {
    expect(isRpcMode(["omp", "--mode", "rpc"])).toBe(true);
    expect(isRpcMode(["omp", "--mode=rpc-ui"])).toBe(true);
    expect(isRpcMode(["omp", "--mode", "text"])).toBe(false);
    expect(isRpcMode(["omp", "--mode", "rpc", "--mode=text"])).toBe(false);
    expect(isRpcMode(["omp", "--mode"])).toBe(false);
  });

  it("publishes authenticated model choices with supported efforts", () => {
    expect(
      getSessionModelOptions([
        {
          provider: "openai",
          id: "gpt-5.6",
          name: "GPT-5.6",
          thinking: { efforts: ["low", "medium", "high", "xhigh"], requiresEffort: false },
        },
        {
          provider: "google",
          id: "gemini-3-pro",
          name: "Gemini 3 Pro",
          thinking: { efforts: ["low", "high"], requiresEffort: true },
        },
        { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
      ]),
    ).toEqual([
      {
        provider: "openai",
        id: "gpt-5.6",
        name: "GPT-5.6",
        efforts: ["off", "low", "medium", "high", "xhigh"],
      },
      {
        provider: "google",
        id: "gemini-3-pro",
        name: "Gemini 3 Pro",
        efforts: ["low", "high"],
      },
      { provider: "openai", id: "gpt-4.1", name: "GPT-4.1", efforts: [] },
    ]);
  });

  it("places models assigned to configured roles before the remaining catalog", () => {
    const models = [
      { provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
      { provider: "anthropic", id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    ];
    const assignments = {
      default: { provider: "openai", id: "gpt-5.6", effort: "high" as const },
      slow: { provider: "anthropic", id: "claude-opus-4.7", effort: "xhigh" as const },
    };

    expect(
      getSessionModelOptions(models, (role) => assignments[role as keyof typeof assignments]),
    ).toMatchObject([
      {
        provider: "openai",
        id: "gpt-5.6",
        roles: ["default"],
        roleEfforts: { default: "high" },
      },
      {
        provider: "anthropic",
        id: "claude-opus-4.7",
        roles: ["slow"],
        roleEfforts: { slow: "xhigh" },
      },
      { provider: "google", id: "gemini-3-pro" },
    ]);
  });

  it("resolves explicit role effort through configured role aliases", () => {
    const selectors: Record<string, string> = {
      default: "openai/gpt-5.6:high",
      slow: "@default:xhigh",
      task: "@slow",
    };

    expect(getConfiguredRoleEffort("default", (role) => selectors[role])).toBe("high");
    expect(getConfiguredRoleEffort("slow", (role) => selectors[role])).toBe("xhigh");
    expect(getConfiguredRoleEffort("task", (role) => selectors[role])).toBe("xhigh");
    expect(getConfiguredRoleEffort("vision", (role) => selectors[role])).toBe("inherit");
  });

  it("normalizes commands and preserves one supplied btw entry", () => {
    const commands = getComposerCommandCatalog([
      { name: "skill:seo", description: "  Audit search visibility  ", source: "skill" },
      { name: "btw", description: "  Existing context  ", source: "builtin" },
      { name: "btw", description: "  Later context  ", source: "builtin" },
    ]);
    expect(commands).toEqual([
      { name: "skill:seo", description: "Audit search visibility" },
      { name: "btw", description: "Existing context" },
    ]);
    expect(commands.filter(({ name }) => name === "btw")).toHaveLength(1);
    expect(
      getComposerCommandCatalog([
        { name: "skill:seo", description: "Audit search visibility", source: "skill" },
      ]),
    ).toEqual([
      { name: "skill:seo", description: "Audit search visibility" },
      { name: "btw", description: "Ask an ephemeral side question using the current session context" },
    ]);
  });

  it.each([
    { mode: "text", nested: false },
    { mode: "rpc-ui", nested: true },
  ])("publishes $mode extension sessions and applies model and effort commands", async ({ mode, nested }) => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", mode);
    let sessionFile: string | null = null;
    if (nested) {
      const directory = await mkdtemp(join(tmpdir(), "omp-remote-extension-"));
      temporaryDirectories.push(directory);
      const parentFile = join(directory, "main.jsonl");
      await writeFile(parentFile, "", "utf8");
      sessionFile = join(directory, "main", "Worker.jsonl");
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const intervals: Array<() => void> = [];
    const model = { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" };
    const setModel = vi.fn().mockResolvedValue(true);
    const setThinkingLevel = vi.fn();
    const sendUserMessage = vi.fn();
    const abort = vi.fn();
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
      sendUserMessage,
      setModel,
      setThinkingLevel,
    };
    const context = {
      cwd: "/workspace/project",
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      abort,
      models: {
        current: () => model,
        list: () => [model],
        resolve: (value: string) => (value === "openai/gpt-5.6" || value === "@default" ? model : undefined),
      },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionName: () => "Test session",
        getSessionFile: () => sessionFile,
      },
      setInterval: vi.fn((callback: () => void) => {
        intervals.push(callback);
        return 0;
      }),
      setTimeout: vi.fn(),
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);

    ompRemoteExtension(pi as unknown as ExtensionAPI);
    expect(pi.on).toHaveBeenCalledTimes(8);
    expect(pi.on.mock.calls.map(([event]) => event)).toEqual([
      "session_start",
      "session_switch",
      "agent_start",
      "agent_end",
      "message_start",
      "message_update",
      "message_end",
      "session_shutdown",
    ]);
    await handlers.get("session_start")?.({}, context);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("The extension did not open its host connection");
    await socket.emit("open");
    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({
      type: "register",
      session: {
        id: "session-1",
        availableModels: [
          {
            provider: "openai",
            id: "gpt-5.6",
            roles: ["default"],
            roleEfforts: { default: "high" },
          },
        ],
      },
    });
    expect(JSON.parse(socket.sent[0] ?? "").session.composerCommands).toEqual([
      { name: "btw", description: "Ask an ephemeral side question using the current session context" },
    ]);
    await handlers.get("message_update")?.(
      {
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Working" }],
        },
      },
      context,
    );
    expect(JSON.parse(socket.sent[1] ?? "")).toMatchObject({
      type: "event",
      sessionId: "session-1",
      event: "message_update",
      message: { text: "Working", streaming: true },
    });
    expect(intervals).toHaveLength(1);
    intervals[0]?.();
    const heartbeat = JSON.parse(socket.sent.at(-1) ?? "");
    expect(heartbeat.type).toBe("heartbeat");
    expect(heartbeat.composerCommands).toEqual([
      { name: "btw", description: "Ask an ephemeral side question using the current session context" },
    ]);

    await socket.emit("message", {
      data: JSON.stringify({ requestId: "prompt-1", command: "prompt", text: "Prompt text" }),
    });
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "Prompt text");
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toMatchObject({
      type: "command_result",
      requestId: "prompt-1",
      ok: true,
    });

    await socket.emit("message", {
      data: JSON.stringify({ requestId: "steer-1", command: "steer", text: "Steer text" }),
    });
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Steer text", { deliverAs: "steer" });
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toMatchObject({
      type: "command_result",
      requestId: "steer-1",
      ok: true,
    });

    await socket.emit("message", {
      data: JSON.stringify({ requestId: "follow-up-1", command: "follow_up", text: "Follow-up text" }),
    });
    expect(sendUserMessage).toHaveBeenNthCalledWith(3, "Follow-up text", { deliverAs: "followUp" });
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toMatchObject({
      type: "command_result",
      requestId: "follow-up-1",
      ok: true,
    });

    await socket.emit("message", {
      data: JSON.stringify({ requestId: "abort-1", command: "abort" }),
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toMatchObject({
      type: "command_result",
      requestId: "abort-1",
      ok: true,
    });

    await socket.emit("message", {
      data: JSON.stringify({
        requestId: "model-1",
        command: "set_model",
        model: "openai/gpt-5.6",
      }),
    });
    expect(setModel).toHaveBeenCalledWith(model);
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toMatchObject({
      type: "command_result",
      requestId: "model-1",
      ok: true,
    });

    await socket.emit("message", {
      data: JSON.stringify({ requestId: "effort-1", command: "set_effort", effort: "xhigh" }),
    });
    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(JSON.parse(socket.sent.at(-1) ?? "")).toMatchObject({
      type: "command_result",
      requestId: "effort-1",
      ok: true,
    });
  });

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
    expect(nativeAskDialog).toHaveBeenCalledWith(questions, options);

    await handlers.get("session_shutdown")?.();
    expect(ui.askDialog).toBe(nativeAskDialog);
    expect(terminalHandlers.size).toBe(0);
  });

  it("waits for admission, disables the competitor timeout, emits activity, and honors parent abort", async () => {
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
    const questions = [{ id: "database", question: "Which database?", options: [{ label: "SQLite" }] }];
    const parentAbort = new AbortController();
    const resultPromise = ui.askDialog(questions, { timeout: 500, signal: parentAbort.signal });
    const request = JSON.parse(socket.sent.at(-1) ?? "");
    expect(nativeAskDialog).not.toHaveBeenCalled();

    await socket.emit("message", {
      data: JSON.stringify({ command: "ask_admitted", requestId: request.request.requestId }),
    });
    await vi.waitFor(() => expect(nativeAskDialog).toHaveBeenCalledOnce());
    const competingOptions = nativeAskDialog.mock.calls[0]?.[1];
    expect(competingOptions).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(competingOptions).not.toHaveProperty("timeout");
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
        response: { kind: "chat" },
      }),
    });
    await expect(remoteResultPromise).resolves.toEqual({ kind: "chat" });
    expect(terminalHandlers.size).toBe(0);
  });

  it("returns native timeout results and reopens native UI after admitted socket loss", async () => {
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
        question: "Which database?",
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
          question: "Which database?",
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
    await socket.emit("close");
    await vi.waitFor(() => expect(nativeAskDialog).toHaveBeenLastCalledWith(questions, fallbackOptions));
    localResolvers.at(-1)?.({ kind: "chat" });
    await expect(fallbackPromise).resolves.toEqual({ kind: "chat" });
  });

  it.each([
    [{ kind: "chat" }, { type: "response", response: { kind: "chat" } }],
    [{ cancelled: true }, { type: "response", response: undefined }],
    [{ cancelled: true, timedOut: true }, { type: "timeout" }],
  ])("normalizes remote rich ask terminal responses", (response, expected) => {
    expect(normalizeRemoteAskResponse(response)).toEqual(expected);
  });

  it("keeps the RPC root session on the daemon RPC transport", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "rpc-ui");
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-extension-root-"));
    temporaryDirectories.push(directory);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const WebSocket = vi.fn();
    vi.stubGlobal("WebSocket", WebSocket);

    ompRemoteExtension({
      zod: { z: compatibilityZ },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
    } as unknown as ExtensionAPI);
    await handlers.get("session_start")?.(
      {},
      {
        sessionManager: {
          getSessionFile: () => join(directory, "main.jsonl"),
        },
      },
    );

    expect(WebSocket).not.toHaveBeenCalled();
  });
});
