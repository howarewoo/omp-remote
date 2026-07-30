import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompRemoteExtension, { getSessionModelOptions, isRpcMode } from "./extension.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.unstubAllGlobals();
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

  it("applies model and effort commands to the active extension session", async () => {
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
        getSessionFile: () => null,
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

  it("does not register remote lifecycle handlers inside an RPC child", () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "rpc");
    const on = vi.fn();

    ompRemoteExtension({ on } as unknown as ExtensionAPI);

    expect(on).not.toHaveBeenCalled();
  });
});
