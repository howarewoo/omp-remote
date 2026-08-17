import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@omp-remote/observability";
import { type RpcFrame, RpcSession } from "@omp-remote/omp-rpc";
import type { AskRequest, Session, SessionModelOption, TranscriptMessage } from "@omp-remote/protocol";
import type { SessionRegistry } from "@omp-remote/sessions/services";
import { waitForCatalogTopology } from "./catalog-reconciliation.js";
import {
  RpcAvailableCommandsResponseSchema,
  RpcAvailableCommandsUpdateSchema,
  RpcAvailableModelsResponseSchema,
  RpcMessageFrameSchema,
  RpcMessagesResponseSchema,
  RpcStateResponseSchema,
} from "./daemon-schemas.js";
import { resolveGitBranch } from "./git-branch.js";
import {
  materializeReadImages,
  normalizeRawMessage,
  normalizeSkillCommands,
  ToolCallTracker,
} from "./message-normalizer.js";
import { normalizeRpcAskEvent } from "./rpc-ask.js";
import {
  createReadImageResolver,
  resolveAgentBlobDirectory,
  type SessionCatalog,
} from "./session-catalog.js";

const MAX_MESSAGES = 200;
const RPC_LAUNCH_DEADLINE_MS = 15_000;

export function resolveInstalledExtensionPath(
  agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"),
): string | undefined {
  const extensionPath = join(agentDirectory, "extensions", "omp-remote.js");
  return existsSync(extensionPath) ? extensionPath : undefined;
}

type RpcSessionRuntimeDependencies = {
  environment: { OMP_REMOTE_OMP_PATH: string };
  registry: SessionRegistry;
  rpcSessions: Map<string, RpcSession>;
  sessionCatalog: SessionCatalog;
  requestCatalogReconciliation: () => Promise<void>;
  setPendingAsk: (request: AskRequest, source: "rpc" | "extension") => void;
  clearPendingAsk: (sessionId: string, requestId?: string) => void;
  markSessionHistorical: (sessionId: string) => void;
  logger: Logger;
};

export function createRpcSessionRuntime({
  environment,
  registry,
  rpcSessions,
  sessionCatalog,
  requestCatalogReconciliation,
  setPendingAsk,
  clearPendingAsk,
  markSessionHistorical,
  logger,
}: RpcSessionRuntimeDependencies) {
  async function launchRpcSession(cwd: string, resume: string | null): Promise<Session> {
    const extensionPath = resolveInstalledExtensionPath();
    const rpc = new RpcSession({
      cwd,
      resume,
      ompPath: environment.OMP_REMOTE_OMP_PATH,
      ...(extensionPath ? { extensionPath } : {}),
      onStderr: (text) => logger.info("OMP RPC stderr", { text: text.trim().slice(0, 1_000) }),
    });
    let sessionId: string | undefined;
    let sessionBlobDirectory: string | undefined;
    let messageSequence = 0;
    let activeMessageId: string | undefined;
    const toolCallTracker = new ToolCallTracker();
    const handleRpcFrame = (frame: RpcFrame): void => {
      if (!sessionId) return;
      const askEvent = normalizeRpcAskEvent(sessionId, frame);
      if (askEvent?.type === "request") {
        setPendingAsk(askEvent.request, "rpc");
        return;
      }
      if (askEvent?.type === "cancel") {
        clearPendingAsk(sessionId, askEvent.requestId);
        return;
      }
      if (frame.type === "agent_start") {
        registry.update(sessionId, { status: "running", lastActivity: new Date().toISOString() });
      } else if (frame.type === "agent_end") {
        registry.update(sessionId, { status: "idle", lastActivity: new Date().toISOString() });
        void refreshRpcState(sessionId, rpc);
      } else if (frame.type === "available_commands_update") {
        const update = RpcAvailableCommandsUpdateSchema.safeParse(frame);
        if (update.success) {
          registry.update(sessionId, { skillCommands: normalizeSkillCommands(update.data.commands) });
        }
      } else if (frame.type === "process_exit") {
        markSessionHistorical(sessionId);
        rpcSessions.delete(sessionId);
        clearPendingAsk(sessionId);
      } else {
        const parsed = RpcMessageFrameSchema.safeParse(frame);
        if (!parsed.success) return;
        if (parsed.data.type === "message_start") {
          activeMessageId = `rpc-message-${sessionId}-${++messageSequence}`;
        }
        const message = normalizeRawMessage(
          parsed.data.message,
          parsed.data.type !== "message_end",
          activeMessageId ?? `rpc-message-${sessionId}-${++messageSequence}`,
          {
            toolCallTracker,
            ...(sessionBlobDirectory
              ? { resolveReadImage: createReadImageResolver(sessionBlobDirectory) }
              : {}),
          },
        );
        if (message) registry.appendMessage(sessionId, message);
        if (parsed.data.type === "message_end") activeMessageId = undefined;
      }
    };
    const processExited = Promise.withResolvers<void>();
    let processHasExited = false;
    const frameReplay = createDeferredRpcFrameReplay(handleRpcFrame);
    const unsubscribe = rpc.subscribe((frame) => {
      if (frame.type === "process_exit") {
        processHasExited = true;
        processExited.resolve();
      }
      frameReplay.accept(frame);
    });
    let isRegistered = false;
    let disposed = false;
    const disposeUnregisteredRpc = async (): Promise<void> => {
      if (disposed || isRegistered) return;
      disposed = true;
      unsubscribe();
      frameReplay.dispose();
      if (!processHasExited) await rpc.terminate().catch(() => {});
    };

    let deadlineTimeout: NodeJS.Timeout | undefined;
    const { promise: deadlinePromise, reject: rejectDeadline } = Promise.withResolvers<never>();
    deadlineTimeout = setTimeout(() => {
      if (isRegistered) return;
      void disposeUnregisteredRpc();
      rejectDeadline(new Error("OMP RPC session launch timed out"));
    }, RPC_LAUNCH_DEADLINE_MS);
    deadlineTimeout.unref();

    const executePreRegistration = async (): Promise<{
      session: Session;
      sessionBlobDirectory: string | undefined;
    }> => {
      const stateResponse = await (async () => {
        try {
          return RpcStateResponseSchema.parse(await rpc.start());
        } catch (error) {
          await disposeUnregisteredRpc();
          throw error;
        }
      })();
      const startedSessionId = stateResponse.data.sessionId;
      if (!startedSessionId) {
        await disposeUnregisteredRpc();
        throw new Error("OMP RPC did not return a session ID");
      }
      sessionId = startedSessionId;
      sessionBlobDirectory = stateResponse.data.sessionFile
        ? resolveAgentBlobDirectory(stateResponse.data.sessionFile)
        : undefined;
      const contextPercent = normalizePercent(stateResponse.data.contextUsage?.percent);
      let catalogSession: Session | undefined;
      if (resume === null) {
        // A fresh OMP session may not have a catalog entry until its first prompt is persisted.
        // Its topology is known: it cannot already have a parent.
        catalogSession = sessionCatalog.get(startedSessionId);
      } else {
        try {
          catalogSession = await waitForCatalogTopology(
            requestCatalogReconciliation,
            () => sessionCatalog.get(startedSessionId),
            processExited.promise,
            waitForCatalogRetry,
            () => processHasExited,
          );
        } catch (error) {
          await disposeUnregisteredRpc();
          throw error;
        }
        if (!catalogSession) {
          await disposeUnregisteredRpc();
          throw new Error("OMP RPC exited before session topology was resolved");
        }
      }
      const [skillCommands, availableModels] = await Promise.all([
        loadRpcSkillCommands(sessionId, rpc),
        loadRpcModelOptions(sessionId, rpc),
      ]);
      const now = new Date().toISOString();
      const session: Session = {
        id: sessionId,
        source: "rpc",
        name: stateResponse.data.sessionName ?? null,
        cwd,
        branch: await resolveGitBranch(cwd),
        status: stateResponse.data.isStreaming
          ? "running"
          : stateResponse.data.queuedMessageCount
            ? "waiting"
            : "idle",
        connected: true,
        model: stateResponse.data.model
          ? `${stateResponse.data.model.provider}/${stateResponse.data.model.id}`
          : null,
        effort: stateResponse.data.thinkingLevel ?? null,
        availableModels,
        contextPercent,
        createdAt: catalogSession?.createdAt ?? now,
        lastActivity: now,
        capabilities: ["prompt", "steer", "follow_up", "abort", "kill", "resume", "model", "effort"],
        messages: [],
        sessionPath: stateResponse.data.sessionFile ?? null,
        parentSessionId: catalogSession?.parentSessionId ?? null,
        activeSubagents: catalogSession?.activeSubagents ?? [],
        skillCommands,
      };
      if (processHasExited) {
        await disposeUnregisteredRpc();
        throw new Error("OMP RPC exited before session registration completed");
      }
      return { session, sessionBlobDirectory };
    };

    let session: Session;
    try {
      const preRegistration = await Promise.race([executePreRegistration(), deadlinePromise]);
      if (disposed) {
        throw new Error("OMP RPC session launch timed out");
      }
      clearTimeout(deadlineTimeout);
      isRegistered = true;
      session = preRegistration.session;
      sessionBlobDirectory = preRegistration.sessionBlobDirectory;
      registry.upsert(session);
      rpcSessions.set(session.id, rpc);
    } catch (error) {
      clearTimeout(deadlineTimeout);
      await disposeUnregisteredRpc();
      throw error;
    }
    const registeredSessionId = session.id;
    const hydratedRawMessages: unknown[] = [];
    try {
      const messagesResponse = RpcMessagesResponseSchema.parse(await rpc.request({ type: "get_messages" }));
      const messages = Array.isArray(messagesResponse.data)
        ? messagesResponse.data
        : messagesResponse.data.messages;
      const visibleMessageStart = Math.max(0, messages.length - MAX_MESSAGES);
      const retained: Array<{ raw: unknown; message: TranscriptMessage }> = [];
      for (const [index, rawMessage] of messages.entries()) {
        const message = normalizeRawMessage(
          rawMessage,
          false,
          `rpc-history-${registeredSessionId}-${Math.max(0, index - visibleMessageStart)}`,
          { toolCallTracker },
        );
        if (index >= visibleMessageStart && message) retained.push({ raw: rawMessage, message });
      }
      const resolveImage = sessionBlobDirectory ? createReadImageResolver(sessionBlobDirectory) : undefined;
      for (const { raw, message } of retained) {
        const materialized = resolveImage ? materializeReadImages(message, raw, resolveImage) : message;
        registry.appendMessage(registeredSessionId, materialized);
        hydratedRawMessages.push(raw);
      }
    } catch (error) {
      logger.error("Could not load initial OMP transcript", error, { sessionId: registeredSessionId });
    } finally {
      frameReplay.register(hydratedRawMessages);
    }
    return registry.get(registeredSessionId) ?? session;
  }

  async function loadRpcSkillCommands(sessionId: string, rpc: RpcSession): Promise<Session["skillCommands"]> {
    try {
      const response = RpcAvailableCommandsResponseSchema.parse(
        await rpc.request({ type: "get_available_commands" }),
      );
      return normalizeSkillCommands(response.data.commands);
    } catch (error) {
      logger.error("Could not load OMP skill commands", error, { sessionId });
      return [];
    }
  }

  async function loadRpcModelOptions(sessionId: string, rpc: RpcSession): Promise<SessionModelOption[]> {
    try {
      const response = RpcAvailableModelsResponseSchema.parse(
        await rpc.request({ type: "get_available_models" }),
      );
      return response.data.models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        efforts: model.thinking
          ? [...(model.thinking.requiresEffort ? [] : (["off"] as const)), ...model.thinking.efforts]
          : [],
      }));
    } catch (error) {
      logger.error("Could not load OMP model choices", error, { sessionId });
      return [];
    }
  }

  async function refreshRpcState(sessionId: string, rpc: RpcSession): Promise<void> {
    try {
      const currentSession = registry.get(sessionId);
      const response = RpcStateResponseSchema.parse(await rpc.request({ type: "get_state" }));
      registry.update(sessionId, {
        name: response.data.sessionName ?? null,
        model: response.data.model ? `${response.data.model.provider}/${response.data.model.id}` : null,
        effort: response.data.thinkingLevel ?? null,
        contextPercent: normalizePercent(response.data.contextUsage?.percent),
        ...(currentSession ? { branch: await resolveGitBranch(currentSession.cwd) } : {}),
        status: response.data.queuedMessageCount ? "waiting" : response.data.isStreaming ? "running" : "idle",
      });
    } catch (error) {
      logger.error("Could not refresh OMP RPC state", error, { sessionId });
    }
  }

  return { launchRpcSession, refreshRpcState };
}

function waitForCatalogRetry(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 100);
  return promise;
}

function normalizePercent(percent: number | undefined): number | null {
  if (percent === undefined || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
}

export interface DeferredRpcFrameReplay {
  accept(frame: RpcFrame): void;
  register(hydratedRawMessages: readonly unknown[]): void;
  dispose(): void;
}

export function createDeferredRpcFrameReplay(applyFrame: (frame: RpcFrame) => void): DeferredRpcFrameReplay {
  let registered = false;
  let replaying = false;
  const deferredFrames: RpcFrame[] = [];

  return {
    accept(frame) {
      if (!registered || replaying) {
        deferredFrames.push(frame);
        return;
      }
      applyFrame(frame);
    },
    register(hydratedRawMessages) {
      if (registered) return;
      registered = true;
      replaying = true;
      const hydrationBoundary = deferredFrames.length;
      const skippedFrameIndexes = getHydratedOverlapFrameIndexes(
        deferredFrames,
        hydrationBoundary,
        hydratedRawMessages,
      );
      for (const [index, frame] of deferredFrames.entries()) {
        if (index >= hydrationBoundary || !skippedFrameIndexes.has(index)) {
          applyFrame(frame);
        }
      }
      deferredFrames.length = 0;
      replaying = false;
    },
    dispose() {
      registered = true;
      deferredFrames.length = 0;
      replaying = false;
    },
  };
}

function getHydratedOverlapFrameIndexes(
  frames: readonly RpcFrame[],
  hydrationBoundary: number,
  hydratedRawMessages: readonly unknown[],
): Set<number> {
  const hydratedMessageCounts = new Map<string, number>();
  for (const message of hydratedRawMessages) {
    const key = getRpcMessageHydrationKey(message);
    if (key) hydratedMessageCounts.set(key, (hydratedMessageCounts.get(key) ?? 0) + 1);
  }

  const skippedFrameIndexes = new Set<number>();
  let activeSequence: number[] | undefined;
  let orphanUpdates = false;
  for (let index = 0; index < hydrationBoundary; index += 1) {
    const parsed = RpcMessageFrameSchema.safeParse(frames[index]);
    if (!parsed.success) continue;
    if (parsed.data.type === "message_start") {
      activeSequence = [index];
      orphanUpdates = false;
      continue;
    }
    if (parsed.data.type === "message_update") {
      if (activeSequence) activeSequence.push(index);
      else orphanUpdates = true;
      continue;
    }
    if (activeSequence) {
      activeSequence.push(index);
      consumeHydratedSequence(
        parsed.data.message,
        activeSequence,
        hydratedMessageCounts,
        skippedFrameIndexes,
      );
      activeSequence = undefined;
      orphanUpdates = false;
    } else if (orphanUpdates) {
      orphanUpdates = false;
    } else {
      consumeHydratedSequence(parsed.data.message, [index], hydratedMessageCounts, skippedFrameIndexes);
    }
  }
  return skippedFrameIndexes;
}

function consumeHydratedSequence(
  completedRawMessage: unknown,
  frameIndexes: readonly number[],
  hydratedMessageCounts: Map<string, number>,
  skippedFrameIndexes: Set<number>,
): void {
  const key = getRpcMessageHydrationKey(completedRawMessage);
  if (!key) return;
  const count = hydratedMessageCounts.get(key) ?? 0;
  if (count === 0) return;
  if (count === 1) hydratedMessageCounts.delete(key);
  else hydratedMessageCounts.set(key, count - 1);
  for (const index of frameIndexes) skippedFrameIndexes.add(index);
}

function getRpcMessageHydrationKey(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const message = raw as Record<string, unknown>;
  if (typeof message.id === "string" || typeof message.role !== "string") return undefined;
  const normalized = normalizeRawMessage(raw, false, "rpc-hydration-key");
  if (!normalized) return undefined;
  const timestamp =
    typeof message.timestamp === "string" || typeof message.timestamp === "number" ? message.timestamp : null;
  return JSON.stringify([
    "idless",
    normalized.role,
    timestamp,
    normalized.text,
    normalized.toolName ?? null,
    normalized.presentation,
  ]);
}
