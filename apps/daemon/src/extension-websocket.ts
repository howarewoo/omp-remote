import {
  type AskRequest,
  ExtensionFrameSchema,
  type ServerFrame,
  type Session,
  type TranscriptMessage,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import {
  type AskInactivityTimeout,
  ownsCurrentExtensionSocket,
  releaseCurrentExtensionSocket,
  resetAskInactivityTimeout,
} from "./rpc-ask.js";
import { SessionCatalog } from "./session-catalog.js";

type PendingAsk = {
  request: AskRequest;
  source: "rpc" | "extension";
  timeout: AskInactivityTimeout | undefined;
};

type ExtensionWebSocketDependencies = {
  extensionSockets: Map<string, WebSocket>;
  extensionSessionBySocket: Map<WebSocket, string>;
  pendingAskBySession: Map<string, PendingAsk>;
  sessionCatalog: SessionCatalog;
  registry: SessionRegistry;
  registerExtensionSession: (session: Session) => Promise<void>;
  ignoreCatalogReconciliationFailure: (reconciliation: Promise<void>) => void;
  sanitizeExtensionSession: <T extends { messages: TranscriptMessage[] }>(
    session: T,
  ) => Omit<T, "messages"> & { messages: TranscriptMessage[] };
  sanitizeTranscriptMessageImages: (message: TranscriptMessage) => TranscriptMessage;
  refreshSessionBranch: (sessionId: string, cwd: string) => void;
  sendExtensionAskUnavailable: (sessionId: string, requestId: string) => void;
  setPendingAsk: (request: AskRequest, source: "rpc" | "extension") => void;
  clearPendingAsk: (sessionId: string, requestId?: string) => void;
  expirePendingAsk: (sessionId: string, requestId: string, source: "rpc" | "extension") => void;
  markSessionHistorical: (sessionId: string) => void;
  broadcast: (frame: ServerFrame) => void;
  isLoopbackAddress: (address: string) => boolean;
};

export function registerExtensionWebSocketRoute(
  app: FastifyInstance,
  {
    extensionSockets,
    extensionSessionBySocket,
    pendingAskBySession,
    sessionCatalog,
    registry,
    registerExtensionSession,
    ignoreCatalogReconciliationFailure,
    sanitizeExtensionSession,
    sanitizeTranscriptMessageImages,
    refreshSessionBranch,
    sendExtensionAskUnavailable,
    setPendingAsk,
    clearPendingAsk,
    expirePendingAsk,
    markSessionHistorical,
    broadcast,
    isLoopbackAddress,
  }: ExtensionWebSocketDependencies,
): void {
  app.get("/extension", { websocket: true }, (socket, request) => {
    if (!isLoopbackAddress(request.ip)) {
      socket.close(1008, "Extensions must connect over loopback");
      return;
    }
    socket.on("message", (raw) => {
      const frame = (() => {
        try {
          return ExtensionFrameSchema.parse(JSON.parse(raw.toString()));
        } catch {
          socket.close(1003, "Invalid extension frame");
          return null;
        }
      })();
      if (!frame) return;

      if (frame.type === "register") {
        const catalogSession = sessionCatalog.get(frame.session.id);
        const previousSessionId = extensionSessionBySocket.get(socket);
        if (previousSessionId && previousSessionId !== frame.session.id) {
          const releasedSessionId = releaseCurrentExtensionSocket(
            socket,
            extensionSessionBySocket,
            extensionSockets,
          );
          if (releasedSessionId) {
            clearPendingAsk(releasedSessionId);
            markSessionHistorical(releasedSessionId);
          }
        }
        const replacedSocket = extensionSockets.get(frame.session.id);
        if (replacedSocket && replacedSocket !== socket) {
          const pending = pendingAskBySession.get(frame.session.id);
          if (pending?.source === "extension") {
            sendExtensionAskUnavailable(frame.session.id, pending.request.requestId);
            clearPendingAsk(frame.session.id, pending.request.requestId);
          }
        }
        extensionSessionBySocket.set(socket, frame.session.id);
        extensionSockets.set(frame.session.id, socket);
        ignoreCatalogReconciliationFailure(
          registerExtensionSession({
            ...sanitizeExtensionSession(frame.session),
            createdAt: catalogSession?.createdAt ?? frame.session.createdAt ?? frame.session.lastActivity,
            activeSubagents: catalogSession?.activeSubagents ?? [],
          }),
        );
        refreshSessionBranch(frame.session.id, frame.session.cwd);
      } else if (frame.type === "ask_request") {
        if (
          !ownsCurrentExtensionSocket(
            socket,
            frame.request.sessionId,
            extensionSessionBySocket,
            extensionSockets,
          ) ||
          frame.request.kind !== "rich"
        ) {
          socket.send(
            JSON.stringify({
              command: "ask_unavailable",
              requestId: frame.request.requestId,
            }),
          );
          return;
        }
        setPendingAsk(frame.request, "extension");
        socket.send(JSON.stringify({ command: "ask_admitted", requestId: frame.request.requestId }));
      } else if (frame.type === "ask_activity") {
        if (ownsCurrentExtensionSocket(socket, frame.sessionId, extensionSessionBySocket, extensionSockets)) {
          const pending = pendingAskBySession.get(frame.sessionId);
          if (pending?.source === "extension") {
            resetAskInactivityTimeout(pending.timeout, frame.sessionId, frame.requestId, () =>
              expirePendingAsk(frame.sessionId, frame.requestId, "extension"),
            );
          }
        }
      } else if (frame.type === "ask_cancelled") {
        if (ownsCurrentExtensionSocket(socket, frame.sessionId, extensionSessionBySocket, extensionSockets)) {
          clearPendingAsk(frame.sessionId, frame.requestId);
        }
      } else if (frame.type === "heartbeat") {
        const currentSession = registry.get(frame.sessionId);
        registry.update(frame.sessionId, {
          connected: true,
          status: frame.idle ? "idle" : "running",
          name: frame.name,
          model: frame.model,
          contextPercent: frame.contextPercent,
          effort: frame.effort,
          availableModels: frame.availableModels,
          lastActivity: new Date().toISOString(),
          ...(frame.skillCommands !== undefined ? { skillCommands: frame.skillCommands } : {}),
        });
        if (currentSession) refreshSessionBranch(frame.sessionId, currentSession.cwd);
      } else if (frame.type === "event") {
        registry.update(frame.sessionId, {
          connected: true,
          ...(frame.event === "agent_start"
            ? { status: "running" as const }
            : frame.event === "agent_end"
              ? { status: "idle" as const }
              : {}),
          name: frame.name,
          model: frame.model,
          contextPercent: frame.contextPercent,
          effort: frame.effort,
          lastActivity: new Date().toISOString(),
        });
        if (frame.message) {
          registry.appendMessage(frame.sessionId, sanitizeTranscriptMessageImages(frame.message));
        }
      } else {
        broadcast({
          type: "command_result",
          requestId: frame.requestId,
          outcome: frame.ok
            ? { status: "ok", value: { type: "void" } }
            : { status: "error", error: frame.error },
        });
      }
    });
    socket.on("close", () => {
      const sessionId = releaseCurrentExtensionSocket(socket, extensionSessionBySocket, extensionSockets);
      if (!sessionId) return;
      clearPendingAsk(sessionId);
      markSessionHistorical(sessionId);
    });
  });
}
