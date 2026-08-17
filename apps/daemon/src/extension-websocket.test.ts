import { type ExtensionFrame, type SessionModelOption } from "@omp-remote/protocol";
import type { SessionRegistry } from "@omp-remote/sessions/services";
import { describe, expect, it } from "vitest";
import { applyRpcSessionMetadata } from "./extension-websocket.js";

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
