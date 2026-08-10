import { type Logger } from "@omp-remote/observability";
import { RpcSession } from "@omp-remote/omp-rpc";
import {
  type AskRequest,
  type Session,
  type SessionModelOption,
  type TranscriptMessage,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import { createReadImageResolver, resolveAgentBlobDirectory, SessionCatalog } from "./session-catalog.js";
import {
  materializeReadImages,
  normalizeRawMessage,
  normalizeComposerCommands,
  ToolCallTracker,
} from "./message-normalizer.js";
import {
  RpcAvailableCommandsResponseSchema,
  RpcAvailableCommandsUpdateSchema,
  RpcAvailableModelsResponseSchema,
  RpcMessageFrameSchema,
  RpcMessagesResponseSchema,
  RpcStateResponseSchema,
} from "./daemon-schemas.js";
import { resolveGitBranch } from "./git-branch.js";
import { normalizeRpcAskEvent } from "./rpc-ask.js";

const MAX_MESSAGES = 200;

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
    const rpc = new RpcSession({
      cwd,
      resume,
      ompPath: environment.OMP_REMOTE_OMP_PATH,
      onStderr: (text) => logger.info("OMP RPC stderr", { text: text.trim().slice(0, 1_000) }),
    });
    let sessionId: string | undefined;
    let sessionBlobDirectory: string | undefined;
    let messageSequence = 0;
    let activeMessageId: string | undefined;
    const toolCallTracker = new ToolCallTracker();
    rpc.subscribe((frame) => {
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
          registry.update(sessionId, { composerCommands: normalizeComposerCommands(update.data.commands) });
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
    });

    const stateResponse = RpcStateResponseSchema.parse(await rpc.start());
    sessionId = stateResponse.data.sessionId;
    if (!sessionId) throw new Error("OMP RPC did not return a session ID");
    sessionBlobDirectory = stateResponse.data.sessionFile
      ? resolveAgentBlobDirectory(stateResponse.data.sessionFile)
      : undefined;
    const contextPercent = normalizePercent(stateResponse.data.contextUsage?.percent);
    const catalogSession = sessionCatalog.get(sessionId);
    const [composerCommands, availableModels] = await Promise.all([
      loadRpcComposerCommands(sessionId, rpc),
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
      activeSubagents: catalogSession?.activeSubagents ?? [],
      composerCommands,
    };
    rpcSessions.set(sessionId, rpc);
    registry.upsert(session);
    void requestCatalogReconciliation();

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
          `rpc-history-${sessionId}-${Math.max(0, index - visibleMessageStart)}`,
          { toolCallTracker },
        );
        if (index >= visibleMessageStart && message) retained.push({ raw: rawMessage, message });
      }
      const resolveImage = sessionBlobDirectory ? createReadImageResolver(sessionBlobDirectory) : undefined;
      for (const { raw, message } of retained) {
        const materialized = resolveImage ? materializeReadImages(message, raw, resolveImage) : message;
        registry.appendMessage(sessionId, materialized);
      }
    } catch (error) {
      logger.error("Could not load initial OMP transcript", error, { sessionId });
    }
    return registry.get(sessionId) ?? session;
  }

  async function loadRpcComposerCommands(
    sessionId: string,
    rpc: RpcSession,
  ): Promise<Session["composerCommands"]> {
    try {
      const response = RpcAvailableCommandsResponseSchema.parse(
        await rpc.request({ type: "get_available_commands" }),
      );
      return normalizeComposerCommands(response.data.commands);
    } catch (error) {
      logger.error("Could not load OMP composer commands", error, { sessionId });
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

function normalizePercent(percent: number | undefined): number | null {
  if (percent === undefined || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
}
