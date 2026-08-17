import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createLogger } from "@omp-remote/observability";
import type { RpcSession } from "@omp-remote/omp-rpc";
import {
  APPLICATION_ERROR_MESSAGE_MAX_CHARS,
  APPLICATION_ERROR_NAME_MAX_CHARS,
  APPLICATION_ERROR_STACK_MAX_CHARS,
  ApplicationErrorLedgerResponseSchema,
  type AskRequest,
  type AskResponse,
  boundTranscriptImageBudget,
  type NotificationEvent,
  type ServerFrame,
  type Session,
  SessionBranchTopologySchema,
  SessionCatalogPageSchema,
  SessionCostResponseSchema,
  SessionFileChangesResponseSchema,
  SessionSchema,
  SessionTranscriptResponseSchema,
  type TranscriptMessage,
  truncateTranscriptText,
  validateTranscriptImageBytes,
} from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { z } from "zod";
import { BranchTopologyCapacityError, createBranchRuntime } from "./branch-runtime.js";
import {
  type BrowserFrameDeliveryResult,
  broadcastBrowserFrame,
  sendBrowserFrame,
} from "./browser-broadcast.js";
import { registerBrowserWebSocketRoute } from "./browser-websocket.js";
import {
  createCatalogReconciler,
  createReconciledSessionRegistrar,
  getCatalogSessionMetadataPatch,
  resolveReconciledSession,
} from "./catalog-reconciliation.js";
import { EnvironmentSchema } from "./daemon-schemas.js";
import { registerExtensionWebSocketRoute } from "./extension-websocket.js";
import { NotificationEventTracker } from "./notification-events.js";
import {
  createBestEffortPushSender,
  PushDeliveryError,
  PushSubscriptionStore,
} from "./push-subscriptions.js";
import {
  type AskInactivityTimeout,
  clearAskInactivityTimeout,
  createAskInactivityTimeout,
  expireExtensionAsk,
} from "./rpc-ask.js";
import { createRpcSessionRuntime } from "./rpc-session-runtime.js";
import { SavedWorkingDirectoryStore } from "./saved-working-directories.js";
import { resolveSessionRoots, SessionCatalog } from "./session-catalog.js";
import { collectSessionFileChanges } from "./session-file-changes.js";
import { ApplicationErrorStore, installUncaughtExceptionMonitor } from "./application-error-store.js";

function sanitizeTranscriptMessageImages(message: TranscriptMessage): TranscriptMessage {
  if (!message.images?.length) return message;
  return {
    ...message,
    images: message.images.map((image) => {
      if (image.status !== "available") return image;
      const bytes = Buffer.from(image.data, "base64");
      return validateTranscriptImageBytes(bytes, image.mimeType)
        ? { status: "unavailable" as const, reason: "mime_mismatch" as const }
        : image;
    }),
  };
}

function sanitizeExtensionSession<T extends { messages: TranscriptMessage[] }>(
  session: T,
): Omit<T, "messages"> & { messages: TranscriptMessage[] } {
  return {
    ...session,
    messages: session.messages.map(sanitizeTranscriptMessageImages),
  };
}

function sanitizeSessionDetails<T extends { messages: TranscriptMessage[] }>(
  session: T,
): Omit<T, "messages"> & { messages: TranscriptMessage[] } {
  const messages = session.messages.slice(-200).map((message) => ({
    ...sanitizeTranscriptMessageImages(message),
    text: truncateTranscriptText(message.text),
  }));
  return { ...session, messages: boundTranscriptImageBudget(messages) };
}

const browserSockets = new Set<WebSocket>();
const errorStore = await ApplicationErrorStore.load();
const logger = createLogger("omp-remote-daemon", {
  onError: async (entry) => {
    try {
      const record = await errorStore.recordFromLogEntry(entry);
      if (record) {
        broadcast({ type: "application_error_added", error: record });
      }
    } catch {
      // Observer errors must never throw or recurse
    }
  },
});
installUncaughtExceptionMonitor(errorStore, broadcast);
const CatalogQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  q: z.string().trim().max(200).default(""),
});
const SessionParamsSchema = z.object({ sessionId: z.string().min(1) });

const environment = EnvironmentSchema.parse(process.env);
const pushSubscriptions = await PushSubscriptionStore.load();
const pushSender = createBestEffortPushSender(pushSubscriptions);
const notificationTracker = new NotificationEventTracker();
const savedWorkingDirectories = await SavedWorkingDirectoryStore.load();
const sessionCatalog = new SessionCatalog(
  await resolveSessionRoots(homedir(), process.env.PI_CODING_AGENT_DIR),
);
const initialCatalogDiff = await sessionCatalog.refresh();
const registry = new SessionRegistry();
sessionCatalog.setDiffListener(({ upserted }) => {
  for (const session of upserted) syncCatalogSession(session);
});
const rpcSessions = new Map<string, RpcSession>();
const extensionSockets = new Map<string, WebSocket>();
const extensionSessionBySocket = new Map<WebSocket, string>();

const pendingAskBySession = new Map<
  string,
  {
    request: AskRequest;
    source: "rpc" | "extension";
    timeout: AskInactivityTimeout | undefined;
  }
>();
const {
  loadSessionBranchTopology,
  refreshSessionBranch,
  branchSwitchBlocksSessionCommand,
  switchSessionBranch,
} = createBranchRuntime({ registry, rpcSessions, extensionSockets });
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
const requestCatalogReconciliation = createCatalogReconciler({
  refresh: () => sessionCatalog.refresh(),
  syncCatalogSession,
  onError: (error) => logger.error("Could not refresh OMP session history", error),
});
const registerExtensionSession = createReconciledSessionRegistrar({
  registerSession: (session) => registry.upsert(session),
  resolveSession: (session) => resolveReconciledSession(session, sessionCatalog.get(session.id)),
  requestCatalogReconciliation,
});
const { launchRpcSession, refreshRpcState } = createRpcSessionRuntime({
  environment,
  registry,
  rpcSessions,
  sessionCatalog,
  requestCatalogReconciliation,
  setPendingAsk,
  clearPendingAsk,
  markSessionHistorical,
  logger,
});

await app.register(fastifyWebsocket, { options: { maxPayload: 96 * 1024 * 1024 } });

app.get("/healthz", async () => ({
  service: "omp-remote",
  status: "ok",
  sessions: registry.list().length,
  timestamp: new Date().toISOString(),
}));

app.get("/api/sessions", async (request, reply) => {
  const query = CatalogQuerySchema.safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid session catalog query" });
  return SessionCatalogPageSchema.parse(
    sessionCatalog.list({
      offset: query.data.offset,
      limit: query.data.limit,
      query: query.data.q,
    }),
  );
});

app.get("/api/sessions/:sessionId", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(404).send({ error: "Session history was not found" });
  const sessionId = params.data.sessionId;
  let liveSession = registry.get(sessionId);
  let catalogSession = liveSession ? undefined : sessionCatalog.get(sessionId);
  if (!liveSession && !catalogSession) {
    await requestCatalogReconciliation();
    liveSession = registry.get(sessionId);
    catalogSession = liveSession ? undefined : sessionCatalog.get(sessionId);
  }
  if (!liveSession && !catalogSession) {
    return reply.code(404).send({ error: "Session history was not found" });
  }
  try {
    const session = liveSession
      ? sanitizeSessionDetails(liveSession)
      : {
          ...catalogSession,
          messages: await sessionCatalog.transcript(sessionId),
        };
    return SessionSchema.parse(session);
  } catch (error) {
    logger.error("Could not read OMP session details", error, { sessionId });
    return reply.code(500).send({ error: "Session details could not be read" });
  }
});

app.get("/api/sessions/:sessionId/transcript", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(404).send({ error: "Session history was not found" });
  const sessionId = params.data.sessionId;
  const catalogSession = sessionCatalog.get(sessionId);
  const liveSession = registry.get(sessionId);
  if (!catalogSession && !liveSession) {
    return reply.code(404).send({ error: "Session history was not found" });
  }
  try {
    return SessionTranscriptResponseSchema.parse({
      sessionId,
      messages: catalogSession ? await sessionCatalog.transcript(sessionId) : (liveSession?.messages ?? []),
    });
  } catch (error) {
    logger.error("Could not read OMP session transcript", error, { sessionId });
    return reply.code(500).send({ error: "Session history could not be read" });
  }
});

app.get("/api/sessions/:sessionId/cost", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(404).send({ error: "Session history was not found" });
  if (!sessionCatalog.get(params.data.sessionId)) await requestCatalogReconciliation();
  if (!sessionCatalog.get(params.data.sessionId)) {
    return reply.code(404).send({ error: "Session history was not found" });
  }
  try {
    return SessionCostResponseSchema.parse({
      sessionId: params.data.sessionId,
      costSummary: (await sessionCatalog.costSummary(params.data.sessionId)) ?? null,
    });
  } catch (error) {
    logger.error("Could not read OMP session cost", error, { sessionId: params.data.sessionId });
    return reply.code(500).send({ error: "Session cost could not be read" });
  }
});

app.get("/api/sessions/:sessionId/changes", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(404).send({ error: "Session history was not found" });
  const selection = sessionCatalog.fileChangeSources(params.data.sessionId);
  if (!selection) return reply.code(404).send({ error: "Session history was not found" });
  try {
    return SessionFileChangesResponseSchema.parse(
      await collectSessionFileChanges({
        sessionId: params.data.sessionId,
        sources: selection.sources,
        truncated: selection.truncated,
      }),
    );
  } catch (error) {
    logger.error("Could not read session file changes", error, { sessionId: params.data.sessionId });
    return reply.code(500).send({ error: "Session file changes could not be read" });
  }
});

app.get("/api/sessions/:sessionId/branches", async (request, reply) => {
  const params = SessionParamsSchema.safeParse(request.params);
  const session = params.success ? registry.get(params.data.sessionId) : undefined;
  if (
    !params.success ||
    !session?.connected ||
    session.source === "history" ||
    session.status === "disconnected" ||
    session.status === "history"
  ) {
    return reply.code(404).send({ error: "Live session was not found" });
  }
  try {
    const topology = await loadSessionBranchTopology(session.cwd, session.id);
    if (!topology) return reply.code(409).send({ error: "Session is not on a local Git branch" });
    const parsedTopology = SessionBranchTopologySchema.safeParse(topology);
    if (!parsedTopology.success) {
      return reply.code(422).send({ error: "Session branch topology exceeds supported limits" });
    }
    return parsedTopology.data;
  } catch (error) {
    if (error instanceof BranchTopologyCapacityError) {
      return reply.code(503).send({ error: "Session branch topology is temporarily unavailable" });
    }
    logger.error("Could not read session branch topology", error, { sessionId: session.id });
    return reply.code(500).send({ error: "Session branch topology could not be read" });
  }
});

app.get("/api/application-errors", async (request, reply) => {
  if (request.headers.origin && !originAllowed(request.headers.origin, request.headers.host)) {
    return reply.code(403).send({ error: "Origin is not allowed" });
  }
  return ApplicationErrorLedgerResponseSchema.parse(errorStore.getLedger());
});

app.delete("/api/application-errors", async (request, reply) => {
  if (request.headers.origin && !originAllowed(request.headers.origin, request.headers.host)) {
    return reply.code(403).send({ error: "Origin is not allowed" });
  }
  try {
    const result = await errorStore.clear();
    broadcast({
      type: "application_errors_cleared",
      clearedAt: new Date().toISOString(),
      clearedCount: result.clearedCount,
    });
    return reply.code(200).send({ ok: true, clearedCount: result.clearedCount });
  } catch (error) {
    logger.warn("Could not clear application errors", {
      error: error instanceof Error ? error.message : String(error),
    });
    return reply.code(500).send({ error: "Application errors could not be cleared" });
  }
});
registerBrowserWebSocketRoute(app, {
  browserSockets,
  pendingAskBySession,
  savedWorkingDirectories,
  pushSubscriptions,
  rpcSessions,
  extensionSockets,
  registry,
  sendToBrowser,
  broadcast,
  launchRpcSession,
  branchSwitchBlocksSessionCommand,
  switchSessionBranch,
  refreshRpcState,
  clearPendingAsk,
  expirePendingAsk,
  originAllowed,
  logger,
  errorStore,
});
registerExtensionWebSocketRoute(app, {
  extensionSockets,
  extensionSessionBySocket,
  pendingAskBySession,
  sessionCatalog,
  registry,
  registerExtensionSession,
  sanitizeExtensionSession,
  sanitizeTranscriptMessageImages,
  refreshSessionBranch,
  setPendingAsk,
  clearPendingAsk,
  expirePendingAsk,
  sendExtensionAskUnavailable,
  markSessionHistorical,
  broadcast,
  isLoopbackAddress,
});

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.raw.method === "GET" &&
      !request.url.startsWith("/healthz") &&
      !request.url.startsWith("/api/")
    )
      return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
}

registry.subscribe((event) => {
  broadcast(event);
  for (const notification of notificationTracker.observeSessions(registry.list())) {
    dispatchNotification(notification);
  }
});
await app.listen({ host: environment.OMP_REMOTE_HOST, port: environment.OMP_REMOTE_PORT });
logger.info("OMP Remote daemon listening", {
  host: environment.OMP_REMOTE_HOST,
  port: environment.OMP_REMOTE_PORT,
});
logger.info("OMP session history indexed", { sessions: initialCatalogDiff.upserted.length });
const catalogRefreshTimer = setInterval(() => {
  ignoreCatalogReconciliationFailure(requestCatalogReconciliation());
}, 10_000);
catalogRefreshTimer.unref();

function ignoreCatalogReconciliationFailure(reconciliation: Promise<void>): void {
  void reconciliation.catch((error) => {
    try {
      logger.error("Catalog reconciliation failed unexpectedly", error);
    } catch {
      // A logging failure cannot be allowed to create another unhandled rejection.
    }
  });
}

function syncCatalogSession(catalogSession: Session): void {
  const liveSession = registry.get(catalogSession.id);
  if (!liveSession) return;

  const patch = getCatalogSessionMetadataPatch(liveSession, catalogSession);
  if (!patch) return;
  registry.update(catalogSession.id, patch);
}

function sendToBrowser(socket: WebSocket, frame: ServerFrame): void {
  reportBrowserBackpressure(sendBrowserFrame(socket, frame));
}
function broadcast(frame: ServerFrame): void {
  reportBrowserBackpressure(broadcastBrowserFrame(browserSockets, frame));
}
function setPendingAsk(request: AskRequest, source: "rpc" | "extension"): void {
  const previous = pendingAskBySession.get(request.sessionId);
  if (previous?.source === "extension") {
    sendExtensionAskUnavailable(request.sessionId, previous.request.requestId);
  }
  clearPendingAsk(request.sessionId);
  const timeout = createAskInactivityTimeout(request.sessionId, request.requestId, request.expiresAt, () =>
    expirePendingAsk(request.sessionId, request.requestId, source),
  );
  pendingAskBySession.set(request.sessionId, { request, source, timeout });
  broadcast({ type: "ask_request", request });
  for (const notification of notificationTracker.observeAsk(request)) {
    dispatchNotification(notification);
  }
}

function clearPendingAsk(sessionId: string, requestId?: string): void {
  const pending = pendingAskBySession.get(sessionId);
  if (!pending || (requestId !== undefined && pending.request.requestId !== requestId)) return;
  clearAskInactivityTimeout(pending.timeout);
  pendingAskBySession.delete(sessionId);
  notificationTracker.clearAsk(sessionId, pending.request.requestId);
  broadcast({
    type: "ask_cancelled",
    sessionId,
    requestId: pending.request.requestId,
  });
}

function expirePendingAsk(sessionId: string, requestId: string, source: "rpc" | "extension"): void {
  const pending = pendingAskBySession.get(sessionId);
  if (!pending || pending.request.requestId !== requestId || pending.source !== source) return;
  if (source === "extension") {
    expireExtensionAsk(sessionId, requestId, sendExtensionAskResponse, clearPendingAsk);
  } else {
    clearPendingAsk(sessionId, requestId);
  }
}

function sendExtensionAskResponse(sessionId: string, requestId: string, response: AskResponse): void {
  const socket = extensionSockets.get(sessionId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        command: "ask_response",
        requestId,
        response,
      }),
    );
  }
}

function sendExtensionAskUnavailable(sessionId: string, requestId: string): void {
  const socket = extensionSockets.get(sessionId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ command: "ask_unavailable", requestId }));
  }
}

function dispatchNotification(notification: NotificationEvent): void {
  broadcast(notification);
  const payload = JSON.stringify(notification);
  void pushSender.send(notification.event, payload).catch((error: unknown) => {
    logger.warn("Session notification delivery failed", {
      event: notification.event,
      failures: error instanceof PushDeliveryError ? error.failures.length : 1,
    });
  });
}

function reportBrowserBackpressure(result: BrowserFrameDeliveryResult): void {
  if (result.terminated === 0) return;
  logger.warn("Terminated lagging dashboard WebSocket peers", {
    terminatedPeers: result.terminated,
    maxRejectedBufferedBytes: result.maxRejectedBufferedBytes,
  });
}

function markSessionHistorical(sessionId: string): void {
  const current = registry.get(sessionId);
  if (!current) return;
  const historical = sessionCatalog.get(sessionId);
  if (historical) {
    registry.upsert({
      ...historical,
      messages: current.messages.map((message) => ({ ...message, streaming: false })),
    });
    return;
  }
  if (current.sessionPath) {
    registry.upsert({
      ...current,
      source: "history",
      status: "history",
      connected: false,
      contextPercent: null,
      capabilities: ["resume"],
      messages: current.messages.map((message) => ({ ...message, streaming: false })),
    });
    return;
  }
  registry.update(sessionId, { connected: false, status: "disconnected" });
}

function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  if (environment.OMP_REMOTE_ORIGIN) return origin === environment.OMP_REMOTE_ORIGIN;
  try {
    const originUrl = new URL(origin);
    const { hostname } = originUrl;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    return (
      originUrl.protocol === "https:" &&
      hostname.endsWith(".ts.net") &&
      originUrl.host === host?.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
