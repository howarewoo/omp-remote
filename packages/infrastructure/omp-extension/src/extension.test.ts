import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompRemoteExtension, {
  getSessionModelOptions,
  isRpcMode,
  normalizeExtensionMessage,
} from "./extension.js";

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

const scalarSchema = {
  min() {
    return this;
  },
  regex() {
    return this;
  },
};
const objectSchema = {
  passthrough() {
    return this;
  },
};
const zod = {
  string: () => scalarSchema,
  enum: () => scalarSchema,
  literal: () => scalarSchema,
  unknown: () => scalarSchema,
  object: () => objectSchema,
  discriminatedUnion: () => ({ parse: (value: unknown) => value }),
};

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
    const model = { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" };
    const setModel = vi.fn().mockResolvedValue(true);
    const setThinkingLevel = vi.fn();
    const pi = {
      zod: { z: zod },
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getThinkingLevel: vi.fn(() => "high"),
      getCommands: vi.fn(() => []),
      sendUserMessage: vi.fn(),
      setModel,
      setThinkingLevel,
    };
    const context = {
      cwd: "/workspace/project",
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      models: {
        current: () => model,
        list: () => [model],
        resolve: (value: string) => (value === "openai/gpt-5.6" ? model : undefined),
      },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionName: () => "Test session",
        getSessionFile: () => sessionFile,
      },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
    };
    vi.stubGlobal("WebSocket", FakeWebSocket);

    ompRemoteExtension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, context);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("The extension did not open its host connection");
    await socket.emit("open");
    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({
      type: "register",
      session: { id: "session-1" },
    });
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

  it("keeps the RPC root session on the daemon RPC transport", async () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "rpc-ui");
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-extension-root-"));
    temporaryDirectories.push(directory);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const WebSocket = vi.fn();
    vi.stubGlobal("WebSocket", WebSocket);

    ompRemoteExtension({
      zod: { z: zod },
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
