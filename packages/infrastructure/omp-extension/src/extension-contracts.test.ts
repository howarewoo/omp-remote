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
  FakeWebSocket.instances.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
describe("normalizeExtensionMessage", () => {
  it("preserves thinking-only assistant content as transcript text", () => {
    expect(
      normalizeExtensionMessage(
        {
          id: "assistant-thinking",
          role: "assistant",
          content: [{ type: "thinking", text: "Evaluating approaches", signature: "sig-123" }],
        },
        true,
        "fallback-id",
      ),
    ).toEqual({
      id: "assistant-thinking",
      role: "assistant",
      text: "Evaluating approaches",
      timestamp: expect.any(String),
      streaming: true,
      presentation: "text",
    });
  });

  it("preserves mixed thinking and text parts in exact source order", () => {
    expect(
      normalizeExtensionMessage(
        {
          id: "assistant-mixed",
          role: "assistant",
          content: [
            { type: "thinking", text: "Planning step 1. " },
            { type: "text", text: "Executing step 1.\n" },
            { type: "thinking", thinking: "Step 1 complete." },
          ],
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({
      id: "assistant-mixed",
      role: "assistant",
      text: "Planning step 1. Executing step 1.\nStep 1 complete.",
      streaming: false,
    });
  });

  it("ignores unsupported parts and rejects malformed thinking payloads", () => {
    expect(
      normalizeExtensionMessage(
        {
          id: "assistant-filtered",
          role: "assistant",
          content: [
            { type: "status", text: "ignored" },
            { type: "thinking", thinking: "Valid thought" },
            { type: "toolCall", name: "bash", arguments: { command: "ls" } },
            { type: "text", text: " and valid text" },
          ],
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({
      id: "assistant-filtered",
      role: "assistant",
      text: "Valid thought and valid text",
    });

    expect(
      normalizeExtensionMessage(
        {
          id: "assistant-empty-thinking",
          role: "assistant",
          content: [{ type: "thinking", thinking: 42 }, { type: "status" }],
        },
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
    setInterval: vi.fn(),
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
